import crypto from "crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { Pool } from "pg";

type Role = "lcvp" | "middle_manager" | "member";

type AuthUser = {
  id: number;
  username: string;
  role: Role;
};

type LeaderboardUpload = {
  userId: number;
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
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock(728019)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(16) NOT NULL CHECK (role IN ('lcvp', 'middle_manager', 'member')),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    )
  `);
  await db.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS manager_id BIGINT REFERENCES app_users(id) ON DELETE RESTRICT");
  await db.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS team_name VARCHAR(80)");
  await db.query("ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check");
  await db.query("UPDATE app_users SET role = 'lcvp' WHERE role = 'admin'");
  await db.query("UPDATE app_users SET role = 'member' WHERE role = 'user'");
  await db.query("ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('lcvp', 'middle_manager', 'member'))");
  await db.query("CREATE INDEX IF NOT EXISTS app_users_active_idx ON app_users (is_active)");
  await db.query("CREATE INDEX IF NOT EXISTS app_users_manager_idx ON app_users (manager_id)");
  await db.query(`
    CREATE TABLE IF NOT EXISTS leaderboard_uploads (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
      role_at_upload VARCHAR(16) NOT NULL CHECK (role_at_upload IN ('middle_manager', 'member')),
      team_manager_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query("CREATE INDEX IF NOT EXISTS leaderboard_uploads_user_date_idx ON leaderboard_uploads (user_id, uploaded_at)");
  await db.query("CREATE INDEX IF NOT EXISTS leaderboard_uploads_team_date_idx ON leaderboard_uploads (team_manager_id, uploaded_at)");
  await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function recordLeaderboardUpload({ userId }: LeaderboardUpload): Promise<void> {
  const result = await getPool().query(
    `INSERT INTO leaderboard_uploads (user_id, role_at_upload, team_manager_id)
     SELECT id, role, CASE WHEN role = 'middle_manager' THEN id ELSE manager_id END
     FROM app_users
     WHERE id = $1 AND role IN ('middle_manager', 'member')
       AND CASE WHEN role = 'middle_manager' THEN id ELSE manager_id END IS NOT NULL`,
    [userId],
  );
  if (!result.rowCount) console.warn(`Leaderboard upload was not recorded for user ${userId}`);
}

function parseRole(value: unknown): Role | null {
  return value === "lcvp" || value === "middle_manager" || value === "member" ? value : null;
}

async function validateManager(managerId: number | null): Promise<string | null> {
  if (!managerId) return "A Middle Manager must be selected for every Member.";
  const result = await getPool().query(
    "SELECT 1 FROM app_users WHERE id = $1 AND role = 'middle_manager' AND is_active = TRUE AND deleted_at IS NULL",
    [managerId],
  );
  return result.rowCount ? null : "The selected Middle Manager is not active or does not exist.";
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
      "SELECT id, username, role, manager_id FROM app_users WHERE id = $1 AND is_active = TRUE AND deleted_at IS NULL",
      [session.id],
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Account is disabled or no longer available" });
    }
    const row = result.rows[0];
    if (row.role === "member" && !row.manager_id) {
      clearSessionCookie(res);
      return res.status(403).json({ error: "Your account needs a Middle Manager assignment. Contact an LCVP." });
    }
    req.authUser = { id: Number(row.id), username: row.username, role: row.role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireLcvp(req: Request, res: Response, next: NextFunction) {
  if (req.authUser?.role !== "lcvp") return res.status(403).json({ error: "LCVP access required" });
  next();
}

export function registerAuthRoutes(router: Router): void {
  router.get("/setup/status", async (_req, res, next) => {
    try {
      const result = await getPool().query("SELECT EXISTS (SELECT 1 FROM app_users WHERE role = 'lcvp') AS complete");
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
         SELECT $1, $2, 'lcvp'
         WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE role = 'lcvp')
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
        "SELECT id, username, password_hash, role, manager_id FROM app_users WHERE username = $1 AND is_active = TRUE AND deleted_at IS NULL",
        [username],
      );
      const row = result.rows[0];
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      if (row.role === "member" && !row.manager_id) {
        return res.status(403).json({ error: "Your account needs a Middle Manager assignment. Contact an LCVP." });
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

  router.get("/users", requireAuth, requireLcvp, async (_req, res, next) => {
    try {
      const result = await getPool().query(
        `SELECT u.id, u.username, u.role, u.manager_id AS "managerId", m.username AS "managerUsername", u.team_name AS "teamName",
                u.is_active AS "isActive", u.created_at AS "createdAt",
                u.last_login_at AS "lastLoginAt", u.deleted_at AS "deletedAt"
         FROM app_users u
         LEFT JOIN app_users m ON m.id = u.manager_id
         ORDER BY CASE u.role WHEN 'lcvp' THEN 1 WHEN 'middle_manager' THEN 2 ELSE 3 END, u.created_at DESC`,
      );
      res.json({ users: result.rows.map((row) => ({ ...row, id: Number(row.id), managerId: row.managerId ? Number(row.managerId) : null })) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/team", requireAuth, async (req, res, next) => {
    try {
      if (req.authUser?.role !== "middle_manager") {
        return res.status(403).json({ error: "Middle Manager access required" });
      }
      const result = await getPool().query(
        `SELECT id, username, role, is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"
         FROM app_users WHERE manager_id = $1 AND role = 'member' AND deleted_at IS NULL ORDER BY username`,
        [req.authUser.id],
      );
      res.json({ members: result.rows.map((row) => ({ ...row, id: Number(row.id) })) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/leaderboards", requireAuth, async (req, res, next) => {
    try {
      const from = typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
      const to = typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
      if ((from && !to) || (!from && to)) return res.status(400).json({ error: "Choose both start and end dates." });
      if (from && to && from > to) return res.status(400).json({ error: "Start date must be before end date." });
      const params = from && to ? [from, to] : [];
      const dateFilter = from && to ? "AND lu.uploaded_at >= $1::date AND lu.uploaded_at < ($2::date + INTERVAL '1 day')" : "";
      const people = await getPool().query(
        `SELECT u.id, u.username, u.role, u.is_active AS "isActive",
                COUNT(lu.id)::int AS uploads, MAX(lu.uploaded_at) AS "lastUploadAt"
         FROM app_users u
         LEFT JOIN leaderboard_uploads lu ON lu.user_id = u.id ${dateFilter}
         WHERE u.role IN ('middle_manager', 'member')
         GROUP BY u.id
         ORDER BY COUNT(lu.id) DESC, MAX(lu.uploaded_at) ASC NULLS LAST, u.created_at ASC`, params,
      );
      const teams = await getPool().query(
        `SELECT manager.id, COALESCE(manager.team_name, 'Team ' || manager.username) AS "teamName",
                manager.username AS "managerUsername", manager.is_active AS "isActive",
                COUNT(lu.id)::int AS uploads, MAX(lu.uploaded_at) AS "lastUploadAt"
         FROM app_users manager
         LEFT JOIN leaderboard_uploads lu ON lu.team_manager_id = manager.id ${dateFilter}
         WHERE manager.role = 'middle_manager'
         GROUP BY manager.id
         ORDER BY COUNT(lu.id) DESC, MAX(lu.uploaded_at) ASC NULLS LAST, manager.created_at ASC`, params,
      );
      const teamMembers = await getPool().query(
        `SELECT manager.id AS "teamId", COALESCE(manager.team_name, 'Team ' || manager.username) AS "teamName",
                u.id, u.username, u.is_active AS "isActive", COUNT(lu.id)::int AS uploads,
                MAX(lu.uploaded_at) AS "lastUploadAt"
         FROM app_users manager
         JOIN app_users u ON u.role = 'member'
         LEFT JOIN leaderboard_uploads lu ON lu.user_id = u.id AND lu.team_manager_id = manager.id ${dateFilter}
         WHERE manager.role = 'middle_manager'
           AND (u.manager_id = manager.id OR lu.id IS NOT NULL)
         GROUP BY manager.id, u.id
         ORDER BY manager.id, COUNT(lu.id) DESC, MAX(lu.uploaded_at) ASC NULLS LAST, u.created_at ASC`, params,
      );
      res.json({
        people: people.rows.map((row) => ({ ...row, id: Number(row.id) })),
        teams: teams.rows.map((row) => ({ ...row, id: Number(row.id) })),
        teamMembers: teamMembers.rows.map((row) => ({ ...row, id: Number(row.id), teamId: Number(row.teamId) })),
        range: from && to ? { from, to } : null,
      });
    } catch (error) { next(error); }
  });

  router.delete("/leaderboards/uploads", requireAuth, requireLcvp, async (_req, res, next) => {
    try {
      const result = await getPool().query("DELETE FROM leaderboard_uploads");
      res.json({ reset: true, deletedUploads: result.rowCount ?? 0 });
    } catch (error) { next(error); }
  });

  router.post("/users", requireAuth, requireLcvp, async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body.username);
      const password = String(req.body.password ?? "");
      const role = parseRole(req.body.role) ?? "member";
      const managerId = role === "member" ? Number(req.body.managerId) || null : null;
      const validationError = validateCredentials(username, password);
      if (validationError) return res.status(400).json({ error: validationError });
      if (role === "member") {
        const managerError = await validateManager(managerId);
        if (managerError) return res.status(400).json({ error: managerError });
      }
      const teamName = role === "middle_manager" ? (String(req.body.teamName ?? "").trim() || `Team ${username}`).slice(0, 80) : null;
      if (teamName) {
        const duplicate = await getPool().query("SELECT 1 FROM app_users WHERE role = 'middle_manager' AND LOWER(COALESCE(team_name, 'Team ' || username)) = LOWER($1)", [teamName]);
        if (duplicate.rowCount) return res.status(409).json({ error: "Team names must be unique." });
      }
      const passwordHash = await hashPassword(password);
      const result = await getPool().query(
        `INSERT INTO app_users (username, password_hash, role, manager_id, team_name) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, role, manager_id AS "managerId", team_name AS "teamName", is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`,
        [username, passwordHash, role, managerId, teamName],
      );
      res.status(201).json({ user: { ...result.rows[0], id: Number(result.rows[0].id) } });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "Username already exists" });
      next(error);
    }
  });

  router.patch("/users/:id", requireAuth, requireLcvp, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid account ID" });
      const existing = await getPool().query("SELECT id, username, role, is_active, manager_id, team_name FROM app_users WHERE id = $1", [id]);
      if (!existing.rowCount) return res.status(404).json({ error: "Account not found" });
      const username = req.body.username === undefined ? existing.rows[0].username : normalizeUsername(req.body.username);
      const role = req.body.role === undefined ? parseRole(existing.rows[0].role)! : parseRole(req.body.role);
      if (!role) return res.status(400).json({ error: "Invalid role" });
      const isActive = req.body.isActive === undefined ? existing.rows[0].is_active : Boolean(req.body.isActive);
      if (req.authUser?.id === id && (!isActive || role !== "lcvp")) {
        return res.status(400).json({ error: "You cannot disable or demote your own account" });
      }
      const managerId = role === "member" ? Number(req.body.managerId ?? existing.rows[0].manager_id) || null : null;
      if (role === "member") {
        const managerError = await validateManager(managerId);
        if (managerError) return res.status(400).json({ error: managerError });
      }
      if (existing.rows[0].role === "middle_manager" && (role !== "middle_manager" || !isActive)) {
        const assigned = await getPool().query(
          "SELECT COUNT(*)::int AS count FROM app_users WHERE manager_id = $1 AND role = 'member' AND deleted_at IS NULL",
          [id],
        );
        if (assigned.rows[0].count > 0) {
          return res.status(400).json({ error: "Reassign this Middle Manager's Members before changing or disabling the account." });
        }
      }
      const password = req.body.password === undefined ? "" : String(req.body.password);
      const validationError = validateCredentials(username, password || "12345678");
      if (validationError) return res.status(400).json({ error: validationError });
      const passwordHash = password ? await hashPassword(password) : null;
      const requestedTeamName = req.body.teamName === undefined ? existing.rows[0].team_name : String(req.body.teamName).trim();
      const teamName = role === "middle_manager" ? (requestedTeamName || `Team ${username}`).slice(0, 80) : null;
      if (role === "middle_manager") {
        const duplicate = await getPool().query("SELECT 1 FROM app_users WHERE role = 'middle_manager' AND LOWER(COALESCE(team_name, 'Team ' || username)) = LOWER($1) AND id <> $2", [teamName, id]);
        if (duplicate.rowCount) return res.status(409).json({ error: "Team names must be unique." });
      }
      const result = await getPool().query(
        `UPDATE app_users SET username = $1, role = $2, is_active = $3, deleted_at = CASE WHEN $3 THEN NULL ELSE deleted_at END,
           password_hash = COALESCE($4, password_hash), manager_id = $5, team_name = $6
         WHERE id = $7
         RETURNING id, username, role, manager_id AS "managerId", team_name AS "teamName", is_active AS "isActive", created_at AS "createdAt", last_login_at AS "lastLoginAt"`,
        [username, role, isActive, passwordHash, managerId, teamName, id],
      );
      res.json({ user: { ...result.rows[0], id: Number(result.rows[0].id) } });
    } catch (error: any) {
      if (error?.code === "23505") return res.status(409).json({ error: "Username already exists" });
      next(error);
    }
  });

  router.delete("/users/:id", requireAuth, requireLcvp, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (req.authUser?.id === id) return res.status(400).json({ error: "You cannot delete your own account" });
      const assigned = await getPool().query(
        "SELECT COUNT(*)::int AS count FROM app_users WHERE manager_id = $1 AND role = 'member' AND deleted_at IS NULL",
        [id],
      );
      if (assigned.rows[0].count > 0) {
        return res.status(400).json({ error: "Reassign this Middle Manager's Members before disabling the account." });
      }
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
