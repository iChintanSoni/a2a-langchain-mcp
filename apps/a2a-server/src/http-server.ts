/**
 * Express HTTP server for the A2A agent.
 *
 * Mounts the three A2A routes (agent card, JSON-RPC, REST) on an Express app
 * and starts listening. All request handling logic lives in the SDK's
 * DefaultRequestHandler; this file is only concerned with HTTP wiring.
 */

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

export function startHttpServer(requestHandler: DefaultRequestHandler): void {
  const corsOrigin = ENV.CORS_ORIGIN === "*" ? "*" : ENV.CORS_ORIGIN.split(",").map(s => s.trim());
  const app = express();
  app.use(cors({ origin: corsOrigin }));
  app.use(express.json());

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

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.status(200).send("OK");
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

  app.listen(ENV.PORT, ENV.HOST, () => {
    log.success("HTTP server listening", {
      url: `http://${ENV.HOST}:${ENV.PORT}`,
      agentCard: `http://${ENV.HOST}:${ENV.PORT}/${AGENT_CARD_PATH}`,
      jsonRpc: `http://${ENV.HOST}:${ENV.PORT}/a2a/jsonrpc`,
      rest: `http://${ENV.HOST}:${ENV.PORT}/a2a/rest`,
    });
  });
}
