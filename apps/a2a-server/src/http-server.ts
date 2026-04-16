/**
 * Express HTTP server for the A2A agent.
 *
 * Mounts the three A2A routes (agent card, JSON-RPC, REST) on an Express app
 * and starts listening. All request handling logic lives in the SDK's
 * DefaultRequestHandler; this file is only concerned with HTTP wiring.
 */

import express from "express";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { type DefaultRequestHandler } from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { ENV } from "#src/env.ts";

export function startHttpServer(requestHandler: DefaultRequestHandler): void {
  const app = express();

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use(
    "/a2a/rest",
    restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  app.listen(ENV.PORT, ENV.HOST, () => {
    console.log(`🚀 HTTP server  http://${ENV.HOST}:${ENV.PORT}`);
    console.log(
      `   Agent card   http://${ENV.HOST}:${ENV.PORT}/${AGENT_CARD_PATH}`,
    );
    console.log(`   JSON-RPC     http://${ENV.HOST}:${ENV.PORT}/a2a/jsonrpc`);
    console.log(`   REST         http://${ENV.HOST}:${ENV.PORT}/a2a/rest`);
  });
}
