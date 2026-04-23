import 'dotenv/config';
import express from "express";
import path from "path";
import multer from "multer";
import cors from "cors";
import type { JWT } from "google-auth-library";

/** Load pdf-parse only when parsing — keeps production baseline RAM low (Render 512MB). */
async function pdf(data: Buffer) {
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

function ingestBreakdownRow(
  byId: Map<string, VitaeBreakdownRow>,
  rubricMax: Map<string, number>,
  criterionId: string,
  row: Record<string, unknown>
): void {
  const maxAllowed = rubricMax.get(criterionId);
  if (maxAllowed === undefined) return;

  let earned = Math.round(Number(row.earned));
  if (!Number.isFinite(earned)) earned = 0;
  earned = Math.max(0, Math.min(maxAllowed, earned));

  let maxPoints = Math.round(Number(row.maxPoints));
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) maxPoints = maxAllowed;
  maxPoints = Math.min(maxPoints, maxAllowed);

  const evidence =
    typeof row.evidence === "string" && row.evidence.trim().length > 0
      ? row.evidence.trim().slice(0, 500)
      : "Not stated in CV";

  byId.set(criterionId, {
    criterionId,
    maxPoints,
    earned,
    evidence,
  });
}

/**
 * Models may send scores as top-level objects AND a parallel `breakdown` array full of zeros /
 * placeholders. Apply sources in priority order so real scores win.
 */
function normalizeVitaeAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  const rubricMax = new Map<string, number>(VITAE_RUBRIC.map((r) => [r.id, r.max]));
  const byId = new Map<string, VitaeBreakdownRow>();
  const rawBreakdown = analysis.breakdown;

  // 1) Top-level rubric objects ({ education: { earned, … }, … }) — authoritative when present
  for (const r of VITAE_RUBRIC) {
    const raw = analysis[r.id];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      ingestBreakdownRow(byId, rubricMax, r.id, raw as Record<string, unknown>);
    }
  }

  // 2) Top-level strings (skills / languages often only appear as plain text)
  for (const r of VITAE_RUBRIC) {
    if (byId.has(r.id)) continue;
    const raw = analysis[r.id];
    if (typeof raw === "string" && raw.trim().length > 0) {
      const maxAllowed = rubricMax.get(r.id);
      if (maxAllowed === undefined) continue;
      byId.set(r.id, {
        criterionId: r.id,
        maxPoints: maxAllowed,
        earned: 0,
        evidence: raw.trim().slice(0, 500),
      });
    }
  }

  // 3) `breakdown` array — only fill IDs we still don't have (skips bogus placeholder rows when top-level already scored)
  if (Array.isArray(rawBreakdown)) {
    for (const raw of rawBreakdown) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const criterionId = String(
        row.criterionId ?? row.id ?? row.category ?? ""
      ).trim();
      if (!criterionId || byId.has(criterionId)) continue;
      ingestBreakdownRow(byId, rubricMax, criterionId, row);
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

  const cleaned: Record<string, unknown> = { ...analysis, breakdown, vitaeScore };
  for (const r of VITAE_RUBRIC) {
    delete cleaned[r.id];
  }

  return cleaned;
}

const ROLE_SKILL_MAP: Array<{ role: string; keywords: string[] }> = [
  {
    role: "Data / Analytics",
    keywords: ["python", "sql", "pandas", "power bi", "tableau", "numpy", "excel", "statistics"],
  },
  {
    role: "Backend Engineering",
    keywords: ["node", "express", "java", "spring", "api", "postgres", "mongodb", "docker"],
  },
  {
    role: "Frontend Engineering",
    keywords: ["react", "javascript", "typescript", "html", "css", "next.js", "tailwind", "redux"],
  },
  {
    role: "Mobile Development",
    keywords: ["android", "ios", "flutter", "react native", "kotlin", "swift", "dart"],
  },
  {
    role: "Cloud / DevOps",
    keywords: ["aws", "azure", "gcp", "kubernetes", "terraform", "ci/cd", "jenkins", "linux"],
  },
];

const CORE_SKILLS = Array.from(
  new Set(
    ROLE_SKILL_MAP.flatMap((r) => r.keywords).concat([
      "git",
      "c++",
      "c#",
      "php",
      "go",
      "machine learning",
      "deep learning",
      "nlp",
      "tensorflow",
      "pytorch",
      "scikit-learn",
      "figma",
      "firebase",
    ])
  )
);

const KNOWN_LANGUAGES = [
  "english",
  "arabic",
  "french",
  "german",
  "spanish",
  "italian",
  "turkish",
  "urdu",
  "hindi",
  "chinese",
];

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function parseName(cvText: string): string {
  const firstLine = cvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Candidate";
  return firstLine.replace(/[^\p{L}\p{N}\s.'-]/gu, "").trim().slice(0, 80) || "Candidate";
}

function parseSkills(cvLower: string): string[] {
  return CORE_SKILLS.filter((skill) => cvLower.includes(skill)).slice(0, 16);
}

function parseLanguages(cvLower: string): string[] {
  return KNOWN_LANGUAGES.filter((lang) => cvLower.includes(lang)).slice(0, 6);
}

function inferMajor(skills: string[]): string {
  let topRole = "General";
  let topScore = 0;
  for (const role of ROLE_SKILL_MAP) {
    const score = role.keywords.reduce((sum, kw) => sum + (skills.includes(kw) ? 1 : 0), 0);
    if (score > topScore) {
      topScore = score;
      topRole = role.role;
    }
  }
  return topRole;
}

function countKeywordHits(cvLower: string, words: string[]): number {
  return words.reduce((sum, word) => sum + (cvLower.includes(word) ? 1 : 0), 0);
}

function capScore(raw: number, max: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(max, Math.round(raw)));
}

type OfflineAnalysis = {
  name: string;
  majors: string;
  languages: string;
  skills: string;
  vitaeScore: number;
  reasoning: string;
  breakdown: VitaeBreakdownRow[];
};

function buildOfflineAnalysis(cvText: string): OfflineAnalysis {
  const cvLower = cvText.toLowerCase();
  const name = parseName(cvText);
  const skillsArr = parseSkills(cvLower);
  const languagesArr = parseLanguages(cvLower);
  const majors = inferMajor(skillsArr);

  const eduHits = countKeywordHits(cvLower, [
    "bachelor",
    "master",
    "phd",
    "university",
    "college",
    "faculty",
    "degree",
  ]);
  const expHits = countKeywordHits(cvLower, [
    "experience",
    "intern",
    "engineer",
    "developer",
    "manager",
    "analyst",
    "worked",
    "employment",
    "project",
  ]);
  const certHits = countKeywordHits(cvLower, [
    "certification",
    "certificate",
    "course",
    "coursera",
    "udemy",
    "aws certified",
    "project",
    "github",
  ]);

  const education = capScore(eduHits * 4, 20);
  const experience = capScore(expHits * 4, 35);
  const skills = capScore(skillsArr.length * 2, 25);
  const languages = capScore(languagesArr.length * 3 + (languagesArr.length > 0 ? 1 : 0), 10);
  const certsProjects = capScore(certHits * 2, 10);

  const breakdown: VitaeBreakdownRow[] = [
    {
      criterionId: "education",
      maxPoints: 20,
      earned: education,
      evidence: education ? "Education-related terms found in CV text." : "No clear education details detected.",
    },
    {
      criterionId: "experience",
      maxPoints: 35,
      earned: experience,
      evidence: experience ? "Experience and role keywords found in CV text." : "No clear work experience signals detected.",
    },
    {
      criterionId: "skills",
      maxPoints: 25,
      earned: skills,
      evidence: skillsArr.length ? `Detected skills: ${skillsArr.slice(0, 8).join(", ")}.` : "No known technical skills matched.",
    },
    {
      criterionId: "languages",
      maxPoints: 10,
      earned: languages,
      evidence: languagesArr.length ? `Detected languages: ${languagesArr.join(", ")}.` : "No languages section detected.",
    },
    {
      criterionId: "certsProjects",
      maxPoints: 10,
      earned: certsProjects,
      evidence: certsProjects ? "Projects/certification keywords detected." : "No clear certifications or projects detected.",
    },
  ];

  const vitaeScore = breakdown.reduce((sum, row) => sum + row.earned, 0);
  const languageSummary = languagesArr.length ? languagesArr.map((l) => l[0].toUpperCase() + l.slice(1)).join(", ") : "Not stated";
  const skillSummary = skillsArr.length ? skillsArr.join(", ") : "general communication, teamwork";

  const reasoning =
    `This score is computed offline with a lightweight keyword rubric to run on low-resource servers. ` +
    `The profile aligns most with ${majors} based on detected skill and experience terms.`;

  return {
    name,
    majors,
    languages: languageSummary,
    skills: skillSummary,
    vitaeScore,
    reasoning,
    breakdown,
  };
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

async function startServer() {
  try {
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

    app.get("/api/health", (req, res) => {
      console.log("Health check requested");
      res.json({ 
        status: "ok", 
        time: new Date().toISOString(),
        env: {
          analysisMode: "offline_rule_based",
          hasGoogleEmail: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          hasGoogleKey: !!process.env.GOOGLE_PRIVATE_KEY,
          googleKeyFormatOk: !!process.env.GOOGLE_PRIVATE_KEY && (process.env.GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY') || process.env.GOOGLE_PRIVATE_KEY.includes('\\n')),
          hasDriveFolderId: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
          hasSheetId: !!process.env.GOOGLE_SHEET_ID,
          nodeEnv: process.env.NODE_ENV
        }
      });
    });

    app.post("/api/analyze", upload.single("cv"), async (req, res) => {
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

        // 2. Analyze with local lightweight rules (no external model calls)
        console.log("Running lightweight offline analysis...");
        const analysis = buildOfflineAnalysis(cvText);

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
    if (process.env.NODE_ENV !== "production") {
      console.log("Starting Vite in middleware mode...");
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite middleware attached");
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("CRITICAL: Server failed to start:", err);
  }
}

startServer();
