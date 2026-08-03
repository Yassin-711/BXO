import 'dotenv/config';
import express from "express";
import path from "path";
import multer from "multer";
import cors from "cors";
import type { JWT } from "google-auth-library";
import { initializeAuthDatabase, registerAuthRoutes, requireAuth } from "./auth.js";

/** Load pdf-parse only when parsing — keeps production baseline RAM low (Render 512MB). */
async function pdf(data: Buffer) {
  const canvas = await import("@napi-rs/canvas");
  const nodeGlobals = globalThis as unknown as Record<string, unknown>;
  nodeGlobals.DOMMatrix ??= canvas.DOMMatrix;
  nodeGlobals.ImageData ??= canvas.ImageData;
  nodeGlobals.Path2D ??= canvas.Path2D;

  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  return { text: result.text };
}

const VITAE_RUBRIC = [
  { id: "education", max: 20, label: "Education & qualifications" },
  { id: "experience", max: 35, label: "Professional experience" },
  { id: "skills", max: 25, label: "Skills & tools" },
  { id: "languages", max: 10, label: "Languages" },
  { id: "certsProjects", max: 10, label: "Certifications & projects" },
] as const;

type VitaeBreakdownRow = {
  criterionId: string;
  maxPoints: number;
  earned: number;
  evidence: string;
};

function buildCvAnalysisPrompt(cvText: string): string {
  const rubricBlock = VITAE_RUBRIC.map(
    (r) => `- \`${r.id}\` — max ${r.max} pts: ${r.label}`,
  ).join("\n");

  return `You are a strict CV evaluator. Score ONLY with the rubric below. Do not bump or cut the total for "overall feel".

## Rubric (fixed weights — sum of max = 100)
${rubricBlock}

## Rules
1. Output exactly **five** breakdown rows, **one per id above**, in this order: ${VITAE_RUBRIC.map((r) => r.id).join(", ")}.
2. For each row set **maxPoints** to that category's max from the rubric. **earned** is an integer with 0 ≤ earned ≤ maxPoints.
3. **education:** no usable education → earned near 0; full use only with clear degree/field.
4. **experience:** no jobs/internships → low score; weight years, relevance, progression, outcomes if stated.
5. **skills:** breadth/depth of tools, domains, methods explicitly listed.
6. **languages:** only if stated; else earned ≤ 2.
7. **certsProjects:** certs, strong projects, publications — 0 if none.
8. **evidence:** one short quote or tight paraphrase from the CV for that category; if nothing applies use "Not stated in CV".
9. **vitaeScore** must equal the sum of all **earned** (same integer sum you use in breakdown).
10. Do not invent employers, degrees, or skills not supported by the text.
11. Extract **name**, **majors**, **languages** (summary line), **skills** (comma-separated). **reasoning** = 2–3 sentences aligned with the breakdown totals.

## CV plain text
${cvText}`;
}

function normalizeVitaeAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const rubricMax = new Map<string, number>(VITAE_RUBRIC.map((r) => [r.id, r.max]));
  const byId = new Map<string, VitaeBreakdownRow>();
  const rawBreakdown = analysis.breakdown;

  if (Array.isArray(rawBreakdown)) {
    for (const raw of rawBreakdown) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      // OpenRouter / Qwen often returns "id" instead of "criterionId"
      const criterionId = String(
        row.criterionId ?? row.id ?? row.category ?? ""
      ).trim();
      const maxAllowed = rubricMax.get(criterionId);
      if (maxAllowed === undefined) continue;

      let earned = Math.round(Number(row.earned));
      if (!Number.isFinite(earned)) earned = 0;
      earned = Math.max(0, Math.min(maxAllowed, earned));

      const evidence =
        typeof row.evidence === "string" && row.evidence.trim().length > 0
          ? row.evidence.trim().slice(0, 500)
          : "Not stated in CV";

      byId.set(criterionId, {
        criterionId,
        maxPoints: maxAllowed,
        earned,
        evidence,
      });
    }
  }

  const breakdown: VitaeBreakdownRow[] = VITAE_RUBRIC.map((r) => {
    return (
      byId.get(r.id) ?? {
        criterionId: r.id,
        maxPoints: r.max,
        earned: 0,
        evidence: "Not scored — missing from model output.",
      }
    );
  });

  const vitaeScore = breakdown.reduce((s, row) => s + row.earned, 0);

  return {
    ...analysis,
    breakdown,
    vitaeScore,
  };
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Qwen3-based “Plus” on OpenRouter; override with OPENROUTER_MODEL. */
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen-plus-2025-07-28";

function stripJsonFromAssistantContent(content: string): string {
  let s = content.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(s);
  if (fenced) return fenced[1].trim();
  return s;
}

async function analyzeCvTextWithOpenRouter(cvText: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey?.trim() || apiKey === "OPENROUTER_API_KEY") {
    throw new Error(
      "OPENROUTER_API_KEY is not configured. Set it in your environment (e.g. Render → Environment)."
    );
  }

  const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  const userPrompt = buildCvAnalysisPrompt(cvText);

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You must respond with a single JSON object only—no markdown code fences, no commentary before or after. Follow the user's schema exactly.",
      },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    top_p: 0.3,
  };

  const maxTok = process.env.OPENROUTER_MAX_TOKENS?.trim();
  if (maxTok) {
    const n = parseInt(maxTok, 10);
    if (Number.isFinite(n) && n > 0) payload.max_tokens = n;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER?.trim();
  if (referer) headers["HTTP-Referer"] = referer;
  const appTitle = process.env.OPENROUTER_APP_NAME?.trim();
  if (appTitle) headers["X-Title"] = appTitle;

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${rawBody.slice(0, 800)}`);
  }

  let data: {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    throw new Error(`OpenRouter returned non-JSON: ${rawBody.slice(0, 200)}`);
  }

  if (data.error?.message) {
    throw new Error(`OpenRouter error: ${data.error.message}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (content == null || typeof content !== "string") {
    throw new Error("OpenRouter returned empty choices[0].message.content");
  }

  const jsonStr = stripJsonFromAssistantContent(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to parse model JSON (${hint}). Snippet: ${jsonStr.slice(0, 400)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model JSON must be a single object");
  }

  return parsed as Record<string, unknown>;
}

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

/** Uses `google-auth-library` only (no `googleapis` mega-bundle) to keep heap small on Render. */
async function createGoogleServiceAccountJwt(): Promise<JWT | null> {
  const { JWT } = await import("google-auth-library");
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;

  if (!email) {
    console.warn("GOOGLE_SERVICE_ACCOUNT_EMAIL is missing.");
    return null;
  }
  if (!key) {
    console.warn("GOOGLE_PRIVATE_KEY is missing.");
    return null;
  }

  key = key.trim().replace(/^['"]|['"]$/g, "");
  key = key.replace(/\\n/g, "\n");

  if (!key.includes("\n") && key.includes("-----BEGIN PRIVATE KEY-----")) {
    console.log("Detected single-line private key, attempting to reformat...");
    const header = "-----BEGIN PRIVATE KEY-----";
    const footer = "-----END PRIVATE KEY-----";
    let content = key.replace(header, "").replace(footer, "").trim();
    content = content.replace(/\s+/g, "");
    const wrappedContent = content.match(/.{1,64}/g)?.join("\n");
    key = `${header}\n${wrappedContent}\n${footer}\n`;
  }

  if (!key.includes("-----BEGIN PRIVATE KEY-----")) {
    console.error("GOOGLE_PRIVATE_KEY is missing the 'BEGIN PRIVATE KEY' header.");
  }

  try {
    console.log("Initializing Google Auth JWT for:", email);
    const jwt = new JWT({
      email,
      key,
      scopes: [...GOOGLE_SCOPES],
    });
    console.log("Google Auth JWT initialized successfully");
    return jwt;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Error creating Google Auth JWT:", message);
    return null;
  }
}

type DriveFileMeta = {
  id?: string;
  name?: string;
  mimeType?: string;
  driveId?: string;
};

/** Service accounts have no personal Drive quota; uploads must target a folder on a Shared Drive (driveId set). */
async function getFolderDriveContext(
  jwt: JWT,
  folderId: string
): Promise<{ ok: true; driveId: string; name: string } | { ok: false; reason: string }> {
  try {
    const url =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}` +
      `?supportsAllDrives=true&fields=id%2Cname%2CmimeType%2CdriveId`;
    const { data } = await jwt.request<DriveFileMeta>({ url, method: "GET" });
    if (data.mimeType !== "application/vnd.google-apps.folder") {
      return { ok: false, reason: "GOOGLE_DRIVE_FOLDER_ID is not a folder." };
    }
    if (!data.driveId) {
      return {
        ok: false,
        reason:
          "This folder is in personal My Drive. Service accounts cannot store files there (no storage quota). Move or create a folder inside a Google Shared Drive (Team Drive), share it with the service account as Content Manager, then set GOOGLE_DRIVE_FOLDER_ID to that folder's ID.",
      };
    }
    return { ok: true, driveId: data.driveId, name: data.name ?? folderId };
  } catch (e: unknown) {
    const err = e as { message?: string; response?: { status?: number } };
    const msg = err?.message ?? String(e);
    const code = err?.response?.status;
    if (code === 404) {
      return {
        ok: false,
        reason:
          "Folder not found or the service account cannot access it. Confirm GOOGLE_DRIVE_FOLDER_ID and that the service account can open this folder (Shared Drive: grant at least Contributor/Content Manager).",
      };
    }
    return { ok: false, reason: `Could not verify folder: ${msg}` };
  }
}

type FolderCtxResult =
  | { ok: true; driveId: string; name: string }
  | { ok: false; reason: string };

const FOLDER_DRIVE_CTX_TTL_MS = 10 * 60 * 1000;
const folderDriveCtxCache = new Map<string, { expiry: number; result: FolderCtxResult }>();

async function getFolderDriveContextCached(jwt: JWT, folderId: string): Promise<FolderCtxResult> {
  const now = Date.now();
  const cached = folderDriveCtxCache.get(folderId);
  if (cached && cached.expiry > now) {
    return cached.result;
  }
  const result = await getFolderDriveContext(jwt, folderId);
  if (result.ok) {
    folderDriveCtxCache.set(folderId, { expiry: now + FOLDER_DRIVE_CTX_TTL_MS, result });
  }
  return result;
}

async function driveMultipartUploadPdf(
  jwt: JWT,
  folderId: string,
  fileName: string,
  pdfBuffer: Buffer
): Promise<string> {
  const boundary = "-------bxoPdfUpload" + Date.now();
  const delimiter = "\r\n--" + boundary + "\r\n";
  const closeDelim = "\r\n--" + boundary + "--";
  const metadata = { name: fileName, parents: [folderId] };
  const body = Buffer.concat([
    Buffer.from(
      delimiter +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        JSON.stringify(metadata)
    ),
    Buffer.from(delimiter + "Content-Type: application/pdf\r\n\r\n"),
    pdfBuffer,
    Buffer.from(closeDelim),
  ]);

  const { data } = await jwt.request<{ id?: string }>({
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true",
    method: "POST",
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
    responseType: "json",
  });

  if (!data?.id) {
    throw new Error("Drive upload returned no file id");
  }
  return data.id;
}

async function driveSetAnyoneReader(jwt: JWT, fileId: string): Promise<void> {
  await jwt.request({
    url:
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions` +
      "?supportsAllDrives=true",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: { role: "reader", type: "anyone" },
  });
}

async function sheetsAppendRow(
  jwt: JWT,
  spreadsheetId: string,
  rangeA1: string,
  row: (string | number)[]
): Promise<void> {
  const enc = encodeURIComponent(rangeA1);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${enc}:append` +
    "?valueInputOption=USER_ENTERED";
  await jwt.request({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: { values: [row] },
  });
}

// --- Configuration ---
const PORT = Number(process.env.PORT) || 3000;
const upload = multer({ storage: multer.memoryStorage() });

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

export async function createApp(options: { serveFrontend?: boolean } = {}) {
    const { serveFrontend = true } = options;
    await initializeAuthDatabase();
    console.log("Authentication database initialized");

    const app = express();
    app.use(cors());
    app.use(express.json());

    // Request Logger
    app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
      next();
    });

    // Google APIs are lazy-loaded inside POST /api/analyze only (saves ~100MB+ at idle on Render).

    // Helper to extract ID from URL if user provided a full URL
    const extractId = (input: string | undefined) => {
      if (!input) return "";
      // Match common Google Drive/Sheets ID patterns in URLs
      const match = input.match(/[-\w]{25,}/);
      return match ? match[0] : input;
    };

    const DRIVE_FOLDER_ID = extractId(process.env.GOOGLE_DRIVE_FOLDER_ID);
    const SHEET_ID = extractId(process.env.GOOGLE_SHEET_ID);

    if (process.env.GOOGLE_DRIVE_FOLDER_ID && DRIVE_FOLDER_ID !== process.env.GOOGLE_DRIVE_FOLDER_ID) {
      console.log(`Extracted Drive Folder ID: ${DRIVE_FOLDER_ID}`);
    }
    if (process.env.GOOGLE_SHEET_ID && SHEET_ID !== process.env.GOOGLE_SHEET_ID) {
      console.log(`Extracted Sheet ID: ${SHEET_ID}`);
    }

    // --- API Routes ---

    const authRouter = express.Router();
    registerAuthRoutes(authRouter);
    app.use("/api", authRouter);

    app.get("/api/health", (req, res) => {
      console.log("Health check requested");
      res.json({ 
        status: "ok", 
        time: new Date().toISOString(),
        env: {
          hasOpenRouterKey:
            !!process.env.OPENROUTER_API_KEY &&
            process.env.OPENROUTER_API_KEY !== "OPENROUTER_API_KEY",
          isPlaceholderOpenRouterKey: process.env.OPENROUTER_API_KEY === "OPENROUTER_API_KEY",
          openRouterModel: process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
          hasGoogleEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY,
          googleKeyFormatOk: !!process.env.GOOGLE_PRIVATE_KEY && (process.env.GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY') || process.env.GOOGLE_PRIVATE_KEY.includes('\\n')),
          hasDriveFolderId: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
          hasSheetId: !!process.env.GOOGLE_SHEET_ID,
          nodeEnv: process.env.NODE_ENV
        }
      });
    });

    app.post("/api/analyze", requireAuth, upload.single("cv"), async (req, res) => {
      console.log("Received analysis request...");
      try {
        if (!req.file) {
          console.log("No file uploaded");
          return res.status(400).json({ error: "No file uploaded" });
        }

        console.log("File received:", req.file.originalname, "Size:", req.file.size);

        if (req.file.mimetype !== "application/pdf") {
          console.log("Invalid mimetype:", req.file.mimetype);
          return res.status(400).json({ error: "Only PDF files are allowed" });
        }

        // 1. Parse PDF Text
        console.log("Parsing PDF...");
        let cvText = "";
        try {
          const pdfData = await pdf(req.file.buffer);
          cvText = pdfData.text;
          console.log("PDF parsed successfully. Text length:", cvText.length);
        } catch (pdfError: any) {
          console.error("PDF Parsing Error:", pdfError);
          return res.status(400).json({ error: "Failed to parse PDF file. It might be corrupted or password protected." });
        }

        if (!cvText || cvText.trim().length < 10) {
          console.log("PDF text too short or empty");
          return res.status(400).json({ error: "The PDF appears to be empty or unreadable (e.g., it might be a scanned image without OCR)." });
        }

        // 2. Analyze with OpenRouter (default: Qwen Plus) — fetch only, no Gemini SDK
        console.log("Calling OpenRouter...");
        let analysis: any = null;
        let retries = 3;
        let lastError: any = null;

        while (retries > 0) {
          try {
            const raw = await analyzeCvTextWithOpenRouter(cvText);
            console.log("Raw OpenRouter analysis:", JSON.stringify(raw).slice(0, 2000));
            analysis = normalizeVitaeAnalysis(raw);
            console.log("OpenRouter analysis successful");
            break;
          } catch (err: any) {
            lastError = err;
            const msg = String(err?.message ?? err);
            const isRetryable =
              msg.includes("429") ||
              msg.includes("502") ||
              msg.includes("503") ||
              msg.includes("529") ||
              msg.includes("UNAVAILABLE") ||
              /rate limit|overloaded|high demand|temporarily/i.test(msg);

            if (isRetryable && retries > 1) {
              console.warn(`OpenRouter busy or rate-limited. Retrying in 2s... (${retries - 1} left)`);
              await new Promise((r) => setTimeout(r, 2000));
              retries--;
            } else {
              console.error("OpenRouter analysis error:", msg);
              throw err;
            }
          }
        }

        if (!analysis) {
          throw lastError || new Error("Failed to analyze CV after retries");
        }

        // 3. Upload to Google Drive (folder MUST be on a Shared Drive — service accounts have no My Drive quota)
        let driveLink = "Not Configured";
        let driveStatus = "skipped";
        let driveMessage: string | undefined;
        let sheetsSynced = false;
        let sheetStatus = "skipped";

        const jwt = await createGoogleServiceAccountJwt();
        const sheetRange = "'Table 1'!A:F";

        if (!jwt) {
          console.warn("Skipping Google Drive/Sheets: Missing Service Account credentials.");
          driveStatus = "missing_credentials";
        } else if (!DRIVE_FOLDER_ID) {
          console.warn("Skipping Google Drive: Missing Folder ID.");
          driveStatus = "missing_folder_id";
        } else {
          console.log(`Uploading to Google Drive folder: ${DRIVE_FOLDER_ID}...`);
          try {
            const folderCtx = await getFolderDriveContextCached(jwt, DRIVE_FOLDER_ID);
            if (folderCtx.ok === false) {
              driveStatus = "requires_shared_drive";
              driveMessage = folderCtx.reason;
              console.error("Drive folder check failed:", folderCtx.reason);
            } else {
              console.log(
                `Folder OK on Shared Drive "${folderCtx.name}" (driveId=${folderCtx.driveId}). Uploading PDF...`
              );

              const fileId = await driveMultipartUploadPdf(
                jwt,
                DRIVE_FOLDER_ID,
                req.file.originalname,
                req.file.buffer
              );
              console.log(`Upload success. File ID: ${fileId}`);

              driveLink = `https://drive.google.com/file/d/${fileId}/view`;
              driveStatus = "success";
              console.log(`Drive link: ${driveLink}`);

              const sheetRow = [
                analysis.name,
                analysis.majors,
                analysis.languages,
                analysis.skills,
                analysis.vitaeScore,
                driveLink,
              ];

              if (SHEET_ID) {
                console.log("Parallel: Drive link permission + Google Sheets append...");
                const [permOutcome, sheetOutcome] = await Promise.allSettled([
                  driveSetAnyoneReader(jwt, fileId),
                  sheetsAppendRow(jwt, SHEET_ID, sheetRange, sheetRow),
                ]);

                if (permOutcome.status === "rejected") {
                  const m =
                    permOutcome.reason instanceof Error
                      ? permOutcome.reason.message
                      : String(permOutcome.reason);
                  console.warn(
                    "Could not set link-sharing (anyone) permission; file may still be open to Shared Drive members:",
                    m
                  );
                }

                if (sheetOutcome.status === "fulfilled") {
                  sheetStatus = "success";
                  sheetsSynced = true;
                  console.log("Sheets sync successful");
                } else {
                  sheetStatus = "error";
                  sheetsSynced = true;
                  const se = sheetOutcome.reason as {
                    response?: { status?: number };
                    status?: number;
                    message?: string;
                  };
                  console.error("Google Sheets Error Details:");
                  console.error("Status:", se.response?.status ?? se.status);
                  console.error("Message:", se?.message ?? sheetOutcome.reason);
                  if (se.response?.status === 400 || se.status === 400) {
                    console.error(`Root Cause: 400 Bad Request. Likely 'Unable to parse range: ${sheetRange}'.`);
                  }
                }
              } else {
                try {
                  await driveSetAnyoneReader(jwt, fileId);
                } catch (permErr: unknown) {
                  const m = permErr instanceof Error ? permErr.message : String(permErr);
                  console.warn(
                    "Could not set link-sharing (anyone) permission; file may still be open to Shared Drive members:",
                    m
                  );
                }
              }
            }
          } catch (driveError: any) {
            driveStatus = "error";
            driveMessage =
              driveError?.message ||
              "Drive upload failed. If you see quota errors, use a folder inside a Shared Drive and grant the service account Content Manager on that drive.";
            console.error("Google Drive Error Details:");
            console.error("Status:", driveError.status || driveError.code);
            console.error("Message:", driveError.message);
            if (driveError.status === 403 || String(driveError.message).includes("storage quota")) {
              console.error(
                "Fix: Use GOOGLE_DRIVE_FOLDER_ID pointing to a folder inside a Team/Shared Drive (not My Drive). Add the service account to that drive with Content Manager."
              );
            }
          }
        }

        // 4. Save to Google Sheets (if not already done in parallel with Drive permission)
        if (!sheetsSynced && jwt && SHEET_ID) {
          console.log(`Saving to Google Sheets (ID: ${SHEET_ID}, Range: ${sheetRange})...`);
          try {
            await sheetsAppendRow(jwt, SHEET_ID, sheetRange, [
              analysis.name,
              analysis.majors,
              analysis.languages,
              analysis.skills,
              analysis.vitaeScore,
              driveLink,
            ]);
            sheetStatus = "success";
            console.log("Sheets sync successful");
          } catch (sheetError: unknown) {
            sheetStatus = "error";
            const se = sheetError as { status?: number; code?: number; message?: string };
            console.error("Google Sheets Error Details:");
            console.error("Status:", se.status || se.code);
            console.error("Message:", se.message);
            if (se.status === 400) {
              console.error(`Root Cause: 400 Bad Request. Likely 'Unable to parse range: ${sheetRange}'.`);
            }
          }
        } else if (!sheetsSynced && jwt && !SHEET_ID) {
          sheetStatus = "missing_sheet_id";
        } else if (!sheetsSynced && !jwt) {
          sheetStatus = "missing_credentials";
        }

        console.log("Analysis complete");
        res.json({
          ...analysis,
          driveLink,
          driveStatus,
          driveMessage,
          sheetStatus,
          success: true
        });

      } catch (error: any) {
        console.error("Analysis Error:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
      }
    });

    // --- Vite Middleware (dev only — dynamic import keeps Vite out of production memory) ---
    if (serveFrontend && process.env.NODE_ENV !== "production") {
      console.log("Starting Vite in middleware mode...");
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware attached");
    } else if (serveFrontend) {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    return app;
}

async function startServer() {
  try {
    const app = await createApp();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("CRITICAL: Server failed to start:", err);
  }
}

if (!process.env.VERCEL) {
  startServer();
}
