import 'dotenv/config';
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import cors from "cors";
import { PDFParse } from 'pdf-parse';

async function pdf(data: Buffer) {
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  return { text: result.text };
}

import { GoogleGenAI, Type } from "@google/genai";
import { google } from "googleapis";
import { Readable } from "stream";

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
      const criterionId = String(row.criterionId ?? "").trim();
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

/** Service accounts have no personal Drive quota; uploads must target a folder on a Shared Drive (driveId set). */
async function getFolderDriveContext(
  drive: ReturnType<typeof google.drive>,
  folderId: string
): Promise<{ ok: true; driveId: string; name: string } | { ok: false; reason: string }> {
  try {
    const { data } = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: "id,name,mimeType,driveId",
    });
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
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const code = e?.code ?? e?.status;
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

    // --- Google APIs Setup ---
    const getGoogleAuth = () => {
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

      // Robust key parsing
      // 1. Remove surrounding quotes if the user pasted them
      key = key.trim().replace(/^['"]|['"]$/g, '');
      
      // 2. Handle literal \n characters (common when pasting from JSON)
      key = key.replace(/\\n/g, '\n');

      // 3. If the key is a single line but contains the headers, it might be missing newlines
      // This happens if the user pastes the key into a single-line input field
      if (!key.includes('\n') && key.includes('-----BEGIN PRIVATE KEY-----')) {
        console.log("Detected single-line private key, attempting to reformat...");
        const header = '-----BEGIN PRIVATE KEY-----';
        const footer = '-----END PRIVATE KEY-----';
        let content = key.replace(header, '').replace(footer, '').trim();
        // Remove any spaces and re-wrap at 64 characters (standard PEM)
        content = content.replace(/\s+/g, '');
        const wrappedContent = content.match(/.{1,64}/g)?.join('\n');
        key = `${header}\n${wrappedContent}\n${footer}\n`;
      }

      // 4. Ensure it has the correct headers
      if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
        console.error("GOOGLE_PRIVATE_KEY is missing the 'BEGIN PRIVATE KEY' header.");
      }

      try {
        console.log("Initializing Google Auth JWT for:", email);
        const auth = new google.auth.JWT({
          email: email,
          key: key,
          scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
        });
        console.log("Google Auth JWT initialized successfully");
        return auth;
      } catch (err: any) {
        console.error("Error creating Google Auth JWT:", err.message);
        return null;
      }
    };

    const drive = google.drive({ version: 'v3', auth: getGoogleAuth() || undefined });
    const sheets = google.sheets({ version: 'v4', auth: getGoogleAuth() || undefined });

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

    // --- Gemini AI Setup ---
    // (Initialized inside the request handler to ensure latest environment variables)

    // --- API Routes ---

    app.get("/api/health", (req, res) => {
      console.log("Health check requested");
      res.json({ 
        status: "ok", 
        time: new Date().toISOString(),
        env: {
          hasGeminiKey: !!process.env.MY_GEMINI_API_KEY && process.env.MY_GEMINI_API_KEY !== "MY_GEMINI_API_KEY",
          isPlaceholderKey: process.env.MY_GEMINI_API_KEY === "MY_GEMINI_API_KEY",
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

        // 2. Analyze with Gemini (with retry logic)
        console.log("Calling Gemini AI...");
        const apiKey = process.env.MY_GEMINI_API_KEY;
        if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
          throw new Error("MY_GEMINI_API_KEY is not configured or is using the placeholder value. Please set a valid API key in the Secrets panel.");
        }

        const genAI = new GoogleGenAI({ apiKey });
        const prompt = buildCvAnalysisPrompt(cvText);

        let analysis: any = null;
        let retries = 3;
        let lastError: any = null;

        while (retries > 0) {
          try {
            const response = await genAI.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: prompt,
              config: {
                temperature: 0.1,
                topP: 0.3,
                seed: 42,
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Full name of the candidate" },
                    majors: { type: Type.STRING, description: "Fields of study or majors" },
                    languages: { type: Type.STRING, description: "Languages spoken with levels (e.g. English - Fluent)" },
                    skills: { type: Type.STRING, description: "Comma separated list of technical and soft skills" },
                    vitaeScore: {
                      type: Type.NUMBER,
                      description: "Must equal the sum of breakdown[].earned; integer 0–100",
                    },
                    reasoning: {
                      type: Type.STRING,
                      description: "2–3 sentences; must align with the rubric breakdown",
                    },
                    breakdown: {
                      type: Type.ARRAY,
                      description:
                        "Exactly 5 rows: education, experience, skills, languages, certsProjects in that order",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          criterionId: {
                            type: Type.STRING,
                            description:
                              "One of: education, experience, skills, languages, certsProjects",
                          },
                          maxPoints: {
                            type: Type.NUMBER,
                            description: "Category max from rubric (20, 35, 25, 10, or 10)",
                          },
                          earned: {
                            type: Type.NUMBER,
                            description: "Integer points earned for this category",
                          },
                          evidence: {
                            type: Type.STRING,
                            description: "Short quote or paraphrase from CV supporting earned points",
                          },
                        },
                        required: ["criterionId", "maxPoints", "earned", "evidence"],
                      },
                    },
                  },
                  required: [
                    "name",
                    "majors",
                    "languages",
                    "skills",
                    "vitaeScore",
                    "reasoning",
                    "breakdown",
                  ],
                },
              },
            });

            const rawText = response.text || "{}";
            console.log("Raw Gemini Text:", rawText);
            analysis = normalizeVitaeAnalysis(JSON.parse(rawText) as Record<string, unknown>);
            console.log("Gemini analysis successful");
            break;
          } catch (err: any) {
            lastError = err;
            const isRetryable = err.message?.includes("503") || err.message?.includes("UNAVAILABLE") || err.message?.includes("high demand");
            
            if (isRetryable && retries > 1) {
              console.warn(`Gemini API busy (503). Retrying in 2s... (${retries - 1} left)`);
              await new Promise(r => setTimeout(r, 2000));
              retries--;
            } else {
              console.error("Gemini Analysis Error:", err.message);
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
        const auth = getGoogleAuth();
        
        if (!auth) {
          console.warn("Skipping Google Drive/Sheets: Missing Service Account credentials.");
          driveStatus = "missing_credentials";
        } else if (!DRIVE_FOLDER_ID) {
          console.warn("Skipping Google Drive: Missing Folder ID.");
          driveStatus = "missing_folder_id";
        } else {
          console.log(`Uploading to Google Drive folder: ${DRIVE_FOLDER_ID}...`);
          try {
            const folderCtx = await getFolderDriveContext(drive, DRIVE_FOLDER_ID);
            if (folderCtx.ok === false) {
              driveStatus = "requires_shared_drive";
              driveMessage = folderCtx.reason;
              console.error("Drive folder check failed:", folderCtx.reason);
            } else {
              console.log(
                `Folder OK on Shared Drive "${folderCtx.name}" (driveId=${folderCtx.driveId}). Uploading PDF...`
              );

              const pdfStream = Readable.from(req.file.buffer);
              const createRes = await drive.files.create({
                requestBody: {
                  name: req.file.originalname,
                  parents: [DRIVE_FOLDER_ID],
                },
                media: {
                  mimeType: "application/pdf",
                  body: pdfStream,
                },
                supportsAllDrives: true,
                fields: "id,name",
              });

              const fileId = createRes.data.id;
              if (!fileId) {
                throw new Error("Drive upload returned no file id");
              }
              console.log(`Upload success. File ID: ${fileId}`);

              try {
                await drive.permissions.create({
                  fileId,
                  supportsAllDrives: true,
                  requestBody: {
                    role: "reader",
                    type: "anyone",
                  },
                });
              } catch (permErr: any) {
                console.warn(
                  "Could not set link-sharing (anyone) permission; file may still be open to Shared Drive members:",
                  permErr?.message ?? permErr
                );
              }

              driveLink = `https://drive.google.com/file/d/${fileId}/view`;
              driveStatus = "success";
              console.log(`Drive link: ${driveLink}`);
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

        // 4. Save to Google Sheets
        let sheetStatus = "skipped";
        if (auth && SHEET_ID) {
          const sheetRange = "'Table 1'!A:F"; // FIX 2: Use correct sheet name with quotes
          console.log(`Saving to Google Sheets (ID: ${SHEET_ID}, Range: ${sheetRange})...`);
          try {
            await sheets.spreadsheets.values.append({
              spreadsheetId: SHEET_ID,
              range: sheetRange,
              valueInputOption: 'USER_ENTERED',
              requestBody: {
                // FIX 3: Ensure correct append format
                values: [[
                  analysis.name,
                  analysis.majors,
                  analysis.languages,
                  analysis.skills,
                  analysis.vitaeScore,
                  driveLink
                ]]
              }
            });
            sheetStatus = "success";
            console.log("Sheets sync successful");
          } catch (sheetError: any) {
            sheetStatus = "error";
            console.error("Google Sheets Error Details:");
            console.error("Status:", sheetError.status || sheetError.code);
            console.error("Message:", sheetError.message);
            if (sheetError.status === 400) {
              console.error(`Root Cause: 400 Bad Request. Likely 'Unable to parse range: ${sheetRange}'.`);
            }
          }
        } else if (auth && !SHEET_ID) {
          sheetStatus = "missing_sheet_id";
        } else {
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

    // --- Vite Middleware ---
    if (process.env.NODE_ENV !== "production") {
      console.log("Starting Vite in middleware mode...");
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
