import cors from "cors";
import express, { type Express } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import { ENV } from "#src/env.ts";
import { createLogger } from "common";

const log = createLogger("file-server/http");

export function createApp(): Express {
  const corsOrigin = ENV.CORS_ORIGIN === "*" ? "*" : ENV.CORS_ORIGIN.split(",").map(s => s.trim());
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "50mb" }));

  // Ensure storage directory exists
  const storageDir = path.resolve(process.cwd(), ENV.STORAGE_DIR);
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
    log.info(`Created storage directory at ${storageDir}`);
  }

  // Setup multer for multipart/form-data file uploads
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, storageDir);
    },
    filename: (req, file, cb) => {
      // Create a unique filename: <uuid>-<original_name>
      const uniqueSuffix = uuidv4();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
      cb(null, `${uniqueSuffix}-${safeName}`);
    },
  });

  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

  // Request logging
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const isHealthCheck = req.method === "GET" && req.path === "/health";

    if (!isHealthCheck && !req.path.startsWith("/files/")) {
      log.event("HTTP request received", { method: req.method, path: req.path });
    }

    res.on("finish", () => {
      if (isHealthCheck && res.statusCode < 400) return;
      if (req.path.startsWith("/files/") && res.statusCode < 400) return;

      const durationMs = Date.now() - startedAt;
      log.info("HTTP request finished", {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
      });
    });

    next();
  });

  // Readiness/Liveness probe endpoint
  app.get("/health", (req, res) => {
    res.status(200).send("OK");
  });

  // ─── REST API ──────────────────────────────────────────────────────────────

  // Upload endpoint
  app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const fileUrl = `${ENV.BASE_URL}/files/${req.file.filename}`;
    log.success("File uploaded", { filename: req.file.filename, size: req.file.size });

    res.status(201).json({
      url: fileUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });

  // Serve static files
  app.use(
    "/files",
    express.static(storageDir, {
      setHeaders: (res, path, stat) => {
        res.set("Access-Control-Allow-Origin", "*");
      },
    }),
  );

  return app;
}
