/**
 * Express HTTP server for the A2A agent.
 *
 * Mounts the three A2A routes (agent card, JSON-RPC, REST) on an Express app
 * and starts listening. All request handling logic lives in the SDK's
 * DefaultRequestHandler; this file is only concerned with HTTP wiring.
 */

import http from "node:http";
import express from "express";
import cors from "cors";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { type DefaultRequestHandler } from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { ENV } from "#src/env.ts";
import { createLogger } from "common";

const log = createLogger("a2a/http");

export function startHttpServer(requestHandler: DefaultRequestHandler): http.Server {
  const corsOrigin = ENV.CORS_ORIGIN === "*" ? "*" : ENV.CORS_ORIGIN.split(",").map(s => s.trim());
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: "10mb" }));

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

  // Deep health check: verifies MCP reachability in addition to liveness
  app.get("/health", async (_req, res) => {
    const mcpUrl = `http://${ENV.MCP_SERVER_HOST}:${ENV.MCP_SERVER_PORT}/health`;
    try {
      const r = await fetch(mcpUrl, { signal: AbortSignal.timeout(2_000) });
      if (!r.ok) throw new Error(`MCP health returned ${r.status}`);
      res.status(200).json({ status: "ok", mcp: "ok" });
    } catch (err) {
      log.warn("Health check: MCP server unreachable", err);
      res.status(503).json({ status: "degraded", mcp: "unreachable" });
    }
  });

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use("/a2a/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = app.listen(ENV.PORT, ENV.HOST, () => {
    log.success("HTTP server listening", {
      url: `http://${ENV.HOST}:${ENV.PORT}`,
      agentCard: `http://${ENV.HOST}:${ENV.PORT}/${AGENT_CARD_PATH}`,
      jsonRpc: `http://${ENV.HOST}:${ENV.PORT}/a2a/jsonrpc`,
      rest: `http://${ENV.HOST}:${ENV.PORT}/a2a/rest`,
    });
  });

  return server;
}
