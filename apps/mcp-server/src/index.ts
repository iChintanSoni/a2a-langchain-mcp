/**
 * MCP Server – HTTP entry point.
 *
 * This file wires up an Express HTTP server that speaks the MCP Streamable HTTP
 * transport protocol. All tool/resource/prompt logic lives in mcp-server.ts and
 * tools.ts; this file only deals with HTTP sessions and routing.
 *
 * Session lifecycle:
 *  POST /mcp  – initialize a new session OR send a message to an existing one
 *  GET  /mcp  – open an SSE stream to receive server-sent events
 *  DELETE /mcp – close and clean up a session
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { ENV } from "#src/env.ts";
import { createMcpServer } from "#src/mcp-server.ts";
import { createLogger } from "common";

const log = createLogger("mcp/http");

const corsOrigin = ENV.CORS_ORIGIN === "*" ? "*" : ENV.CORS_ORIGIN.split(",").map(s => s.trim());
const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

if (!ENV.TAVILY_API_KEY) {
  log.warn("TAVILY_API_KEY is not configured; web_search will fail until it is set.");
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const isHealthCheck = req.method === "GET" && req.path === "/health";

  if (!isHealthCheck) {
    log.event("HTTP request received", {
      method: req.method,
      path: req.path,
      sessionId,
    });
  }

  res.on("finish", () => {
    if (isHealthCheck && res.statusCode < 400) {
      return;
    }

    const requestSummary = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      sessionId,
    };

    if (isHealthCheck) {
      log.warn("Health check request failed", requestSummary);
      return;
    }

    log.info("HTTP request finished", requestSummary);
  });

  next();
});

// Readiness/Liveness probe endpoint
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// In-memory session store: sessionId → active transport
const sessions = new Map<string, StreamableHTTPServerTransport>();

// ─── POST /mcp ─────────────────────────────────────────────────────────────
// Handles both "initialize" (new session) and regular messages.

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // If the client sends a known session ID, route to that existing session.
  if (sessionId && sessions.has(sessionId)) {
    log.event("Routing POST to existing MCP session", { sessionId });
    await sessions.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  // No session ID (or unknown ID) → start a new session.
  const id = randomUUID();
  log.event("Creating new MCP session", { sessionId: id });

  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    // Tell the transport what ID to use and store it once initialized.
    sessionIdGenerator: () => id,
    onsessioninitialized: (sid): void => {
      sessions.set(sid, transport);
      log.success("MCP session initialized", { sessionId: sid });
    },
  });

  // Clean up when the client disconnects.
  transport.onclose = () => {
    sessions.delete(id);
    log.warn("MCP session closed", { sessionId: id });
  };

  // Connect a fresh MCP server to this transport and handle the request.
  const server = createMcpServer();
  log.debug("Connecting MCP server to transport", { sessionId: id });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── GET /mcp ──────────────────────────────────────────────────────────────
// Keeps an SSE connection open so the server can push events to the client.

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    log.warn("Rejected GET for missing or invalid MCP session", { sessionId });
    res.status(400).json({ error: "Missing or invalid mcp-session-id header." });
    return;
  }

  log.event("Streaming MCP session events", { sessionId });
  await transport.handleRequest(req, res);
});

// ─── DELETE /mcp ───────────────────────────────────────────────────────────
// Lets the client explicitly close a session.

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? sessions.get(sessionId) : undefined;

  if (transport) {
    log.event("Closing MCP session", { sessionId });
    await transport.close();
    sessions.delete(sessionId!);
  }

  res.status(200).end();
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(ENV.PORT, ENV.HOST, () => {
  log.success("MCP server listening", {
    url: `http://${ENV.HOST}:${ENV.PORT}/mcp`,
    tools: ["web_search", "generate_image", "read_url", "get_datetime"],
    resources: ["chat://instructions"],
    prompts: ["chat_agent"],
  });
});
