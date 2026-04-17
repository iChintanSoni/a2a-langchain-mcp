/**
 * A2A server entry point.
 *
 * Wires together the agent card, request handler, and transport servers.
 * All logic lives in focused modules:
 *  - agent-card.ts    → AgentCard definition
 *  - agent-executor.ts → ChatAgentExecutor (LangChain ↔ A2A bridge)
 *  - http-server.ts   → Express routes (agent card, JSON-RPC, REST)
 *  - grpc-server.ts   → gRPC server
 *  - mcp-client.ts    → MCP client (tools, resources, prompts)
 */

import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { createLogger } from "common";
import { agentCard } from "#src/agent-card.ts";
import ChatAgentExecutor from "#src/agent-executor.ts";
import { getMCPClient } from "#src/mcp-client.ts";
import { startHttpServer } from "#src/http-server.ts";
import { startGrpcServer } from "#src/grpc-server.ts";

const log = createLogger("a2a");

log.event("Booting A2A server");
const mcpClient = getMCPClient();
log.success("MCP client prepared");

const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new ChatAgentExecutor(mcpClient),
);

log.info("Request handler initialized");

startHttpServer(requestHandler);
startGrpcServer(requestHandler);
