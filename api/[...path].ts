import type { Request, Response } from "express";
import { createApp } from "../server";

const appPromise = createApp({ serveFrontend: false });

export default async function handler(req: Request, res: Response) {
  try {
    const app = await appPromise;
    return app(req, res);
  } catch (error) {
    console.error("Vercel function initialization failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Server initialization failed",
      });
    }
  }
}
