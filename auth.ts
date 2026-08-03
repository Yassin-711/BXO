import crypto from "crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { Pool } from "pg";

type Role = "admin" | "user";

type AuthUser = {
  id: number;
  username: string;
  role: Role;
};

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const NORMAL_SESSION_SECONDS = 24 * 60 * 60;
const REMEMBERED_SESSION_SECONDS = 90 * 24 * 60 * 60;
const COOKIE_NAME = "bxo_session";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }
  pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  });
  return pool;
}

export async function initializeAuthDatabase(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL CHECK (role IN ('admin', 'user')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS app_users_active_idx ON app_users (is_active)");
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  return secret;
}

function normalizeUsername(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function validateCredentials(username: string, password: string): string | null {
  if (username.length < 3 || username.length > 64 || !USERNAME_PATTERN.test(username)) {
    return "Username must be 3-64 characters and use only letters, numbers, dots, underscores, or hyphens.";
  }
  if (password.length < 8) return "Password must contain at least 8 characters.";
  return null;
}

function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`);
    });
  });
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [algorithm, saltHex, keyHex] = stored.split("$");
    if (algorithm !== "scrypt" || !saltHex || !keyHex) return resolve(false);
    const expected = Buffer.from(keyHex, "hex");
    crypto.scrypt(password, Buffer.from(saltHex, "hex"), expected.length, { N: 16384, r: 8, p: 1 }, (error, actual) => {
      resolve(!error && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
    });
  });
}

function signSession(user: AuthUser, maxAgeSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ id: user.id, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds })).toString("base64url");
  const signature = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return null;
}

function parseSession(req: Request): { id: number; exp: number } | null {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", getSessionSecret()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isInteger(parsed.id) || !Number.isInteger(parsed.exp) || parsed.exp <= Date.now() / 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = parseSession(req);
    if (!session) return res.status(401).json({ error: "Authentication required" });
    const result = await getPool().query(
      "SELECT id, username, role FROM app_users WHERE id = $1 AND is_active = TRUE AND deleted_at IS NULL",
      [session.id],
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Account is disabled or no longer available" });
    }
    const row = result.rows[0];
    req.authUser = { id: Number(row.id), username: row.username, role: row.role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.authUser?.role !== "admin") return res.status(403).json({ error: "Administrator access required" });
  next();
}

export function registerAuthRoutes(router: Router): void {
  router.get("/setup/status", async (_req, res, next) => {
    try {
      const result = await getPool().query("SELECT EXISTS (SELECT 1 FROM app_users WHERE role = 'admin') AS complete");
      res.json({ setupRequired: !result.rows[0].complete });
    } catch (error) {
      next(error);
    }
  });

  router.post("/setup", async (req, res, next) => {
    try {
      const setupToken = process.env.INITIAL_SETUP_TOKEN?.trim();
      if (!setupToken) return res.status(503).json({ error: "INITIAL_SETUP_TOKEN is not configured" });
      const suppliedToken = String(req.body.setupToken ?? "");
      const expected = Buffer.from(setupToken);
      const actual = Buffer.from(suppliedToken);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        return res.status(403).json({ error: "Invalid setup token" });
      }
      const username = normalizeUsername(req.body.username);
      const password = String(req.body.password ?? "");
      const validationError = validateCredentials(username, password);
      if (validationError) return res.status(400).json({ error: validationError });
      const passwordHash = await hashPassword(password);
      const result = await getPool().query(
        `INSERT INTO app_users (username, password_hash, role)
         SELECT $1, $2, 'admin'
         WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE role = 'admin')
         RETURNING id, username, role`,
        [username, passwordHash],
      );
      if (!result.rowCount) return res.status(409).json({ error: "Initial setup has already been completed" });
      const user = { ...result.rows[0], id: Number(result.rows[0].id) } as AuthUser;
      setSessionCookie(res, signSession(user, NORMAL_SESSION_SECONDS), NORMAL_SESSION_SECONDS);
      res.status(201).json({ user });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "Username already exists" });
      next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body.username);
      const password = String(req.body.password ?? "");
      const result = await getPool().query(
        "SELECT id, username, password_hash, role FROM app_users WHERE username = $1 AND is_active = TRUE AND deleted_at IS NULL",
        [username],
      );
      const row = result.rows[0];
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      const user: AuthUser = { id: Number(row.id), username: row.username, role: row.role };
      const maxAge = req.body.rememberMe ? REMEMBERED_SESSION_SECONDS : NORMAL_SESSION_SECONDS;
      setSessionCookie(res, signSession(user, maxAge), maxAge);
      await getPool().query("UPDATE app_users SET last_login_at = NOW() WHERE id = $1", [user.id]);
      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get("/me", requireAuth, (req, res) => res.json({ user: req.authUser }));

  router.get("/users", requireAuth, requireAdmin, async (_req, res, next) => {
    try {
      const result = await getPool().query(
        `SELECT id, username, role, is_active AS "isActive", created_at AS "createdAt",
                last_login_at AS "lastLoginAt", deleted_at AS "deletedAt"
         FROM app_users ORDER BY created_at DESC`,
      );
      res.json({ users: result.rows.map((row) => ({ ...row, id: Number(row.id) })) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/users", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body.username);
      const password = String(req.body.password ?? "");
      const role: Role = req.body.role === "admin" ? "admin" : "user";
      const validationError = validateCredentials(username, password);
      if (validationError) return res.status(400).json({ error: validationError });
      const passwordHash = await hashPassword(password);
      const result = await getPool().query(
        `INSERT INTO app_users (username, password_hash, role) VALUES ($1, $2, $3)
         RETURNING id, username, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`,
        [username, passwordHash, role],
      );
      res.status(201).json({ user: { ...result.rows[0], id: Number(result.rows[0].id) } });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "Username already exists" });
      next(error);
    }
  });

  router.patch("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid account ID" });
      const existing = await getPool().query("SELECT id, username, role, is_active FROM app_users WHERE id = $1", [id]);
      if (!existing.rowCount) return res.status(404).json({ error: "Account not found" });
      const username = req.body.username === undefined ? existing.rows[0].username : normalizeUsername(req.body.username);
      const role: Role = req.body.role === undefined ? existing.rows[0].role : req.body.role === "admin" ? "admin" : "user";
      const isActive = req.body.isActive === undefined ? existing.rows[0].is_active : Boolean(req.body.isActive);
      if (req.authUser?.id === id && (!isActive || role !== "admin")) {
        return res.status(400).json({ error: "You cannot disable or demote your own account" });
      }
      const password = req.body.password === undefined ? "" : String(req.body.password);
      const validationError = validateCredentials(username, password || "12345678");
      if (validationError) return res.status(400).json({ error: validationError });
      const passwordHash = password ? await hashPassword(password) : null;
      const result = await getPool().query(
        `UPDATE app_users SET username = $1, role = $2, is_active = $3, deleted_at = CASE WHEN $3 THEN NULL ELSE deleted_at END,
           password_hash = COALESCE($4, password_hash)
         WHERE id = $5
         RETURNING id, username, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`,
        [username, role, isActive, passwordHash, id],
      );
      res.json({ user: { ...result.rows[0], id: Number(result.rows[0].id) } });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "Username already exists" });
      next(error);
    }
  });

  router.delete("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (req.authUser?.id === id) return res.status(400).json({ error: "You cannot delete your own account" });
      const result = await getPool().query(
        `UPDATE app_users SET is_active = FALSE, deleted_at = COALESCE(deleted_at, NOW())
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Account not found" });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
}
