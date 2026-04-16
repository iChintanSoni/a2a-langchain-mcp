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
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { ENV } from "#src/env.ts";
import { createMcpServer } from "#src/mcp-server.ts";

const app = express();
app.use(express.json());

// In-memory session store: sessionId → active transport
const sessions = new Map<string, StreamableHTTPServerTransport>();

// ─── POST /mcp ─────────────────────────────────────────────────────────────
// Handles both "initialize" (new session) and regular messages.

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // If the client sends a known session ID, route to that existing session.
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.handleRequest(req, res, req.body);
    return;
  }

  // No session ID (or unknown ID) → start a new session.
  const id = randomUUID();

  const transport: StreamableHTTPServerTransport =
    new StreamableHTTPServerTransport({
      // Tell the transport what ID to use and store it once initialized.
      sessionIdGenerator: () => id,
      onsessioninitialized: (sid): void => {
        sessions.set(sid, transport);
      },
    });

  // Clean up when the client disconnects.
  transport.onclose = () => sessions.delete(id);

  // Connect a fresh MCP server to this transport and handle the request.
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── GET /mcp ──────────────────────────────────────────────────────────────
// Keeps an SSE connection open so the server can push events to the client.

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    res
      .status(400)
      .json({ error: "Missing or invalid mcp-session-id header." });
    return;
  }

  await transport.handleRequest(req, res);
});

// ─── DELETE /mcp ───────────────────────────────────────────────────────────
// Lets the client explicitly close a session.

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? sessions.get(sessionId) : undefined;

  if (transport) {
    await transport.close();
    sessions.delete(sessionId!);
  }

  res.status(200).end();
});

// ─── Start ─────────────────────────────────────────────────────────────────

app.listen(ENV.PORT, ENV.HOST, () => {
  console.log(`🚀 MCP Server running at http://${ENV.HOST}:${ENV.PORT}/mcp`);
  console.log("   Tools    : web_search, read_url, get_datetime");
  console.log("   Resources: pa://instructions");
  console.log("   Prompts  : personal_assistant");
});
