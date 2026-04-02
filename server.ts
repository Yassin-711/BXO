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

// --- Configuration ---
const PORT = 3000;
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
        const prompt = `Analyze the following CV text and extract structured information.
        Return ONLY valid JSON in this exact format:
        {
          "name": "Candidate Name",
          "majors": "Field of Study",
          "languages": "Languages spoken",
          "skills": "Technical and soft skills",
          "vitaeScore": 85,
          "reasoning": "Brief explanation"
        }
        ❌ No explanations
        ❌ No extra text
        ❌ No markdown

        Text: ${cvText}`;

        let analysis: any = null;
        let retries = 3;
        let lastError: any = null;

        while (retries > 0) {
          try {
            const response = await genAI.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: prompt,
              config: {
                responseMimeType: "application/json",
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: "Full name of the candidate" },
                    majors: { type: Type.STRING, description: "Fields of study or majors" },
                    languages: { type: Type.STRING, description: "Languages spoken with levels (e.g. English - Fluent)" },
                    skills: { type: Type.STRING, description: "Comma separated list of technical and soft skills" },
                    vitaeScore: { type: Type.NUMBER, description: "A score from 0 to 100 based on skills, education, certifications, and experience" },
                    reasoning: { type: Type.STRING, description: "Brief explanation for the score" }
                  },
                  required: ["name", "majors", "languages", "skills", "vitaeScore"]
                }
              }
            });

            const rawText = response.text || "{}";
            console.log("Raw Gemini Text:", rawText);
            analysis = JSON.parse(rawText);
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

        // 3. Upload to Google Drive
        let driveLink = "Not Configured";
        let driveStatus = "skipped";
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
            // FIX: Use manual multipart upload as requested to ensure 'parents' are correctly handled
            // This avoids the 403 "Service Accounts do not have storage quota" error by ensuring
            // the file is created directly inside the shared folder instead of the service account's root.
            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const metadata = {
              name: req.file.originalname,
              parents: [DRIVE_FOLDER_ID]
            };

            // CRITICAL: Ensure the service account has 'Content Manager' role on the Shared Drive
            // to avoid quota errors and allow setting permissions.
            const multipartRequestBody = Buffer.concat([
              Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)),
              Buffer.from(delimiter + 'Content-Type: application/pdf\r\n\r\n'),
              req.file.buffer,
              Buffer.from(close_delim)
            ]);

            console.log("Sending multipart upload request to Google Drive (Shared Drive support enabled)...");
            const driveResponse = await auth.request({
              // supportsAllDrives=true is critical for Shared Drives / Team Drives
              url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
              method: 'POST',
              headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`,
              },
              body: multipartRequestBody
            });

            const fileId = (driveResponse.data as any).id;
            console.log(`Upload success! Shared Drive Folder ID used: ${DRIVE_FOLDER_ID}`);
            console.log(`File ID returned: ${fileId}`);

            // We still need to set permissions so the link is viewable
            await drive.permissions.create({
              fileId: fileId!,
              supportsAllDrives: true, // Required for files on Shared Drives
              requestBody: {
                role: 'reader',
                type: 'anyone'
              }
            });

            // FIX 1: Generate direct file link
            driveLink = `https://drive.google.com/file/d/${fileId}/view`;
            driveStatus = "success";
            console.log(`Drive link generated: ${driveLink}`);
          } catch (driveError: any) {
            driveStatus = "error";
            console.error("Google Drive Error Details:");
            console.error("Status:", driveError.status || driveError.code);
            console.error("Message:", driveError.message);
            if (driveError.status === 403) {
              console.error("Root Cause: 403 Forbidden. This often means 'Service Accounts do not have storage quota'.");
              console.error("CRITICAL FIX: Ensure the target folder is inside a SHARED DRIVE (Team Drive).");
              console.error("CRITICAL FIX: Ensure the service account (cv-analyzer-bot@boreal-ward-472922-e3.iam.gserviceaccount.com) has the 'Content Manager' role on that Shared Drive.");
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
