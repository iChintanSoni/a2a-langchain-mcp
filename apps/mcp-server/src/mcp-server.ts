/**
 * MCP server factory.
 *
 * Call createMcpServer() to get a fresh McpServer with all tools, resources,
 * and prompts registered. A new instance is created per HTTP session so that
 * each client gets its own isolated server state.
 *
 * Registrations are split across focused modules:
 *  - tools.ts     → registerTools()
 *  - resources.ts → registerResources()
 *  - prompts.ts   → registerPrompts()
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "#src/tools.ts";
import { registerResources } from "#src/resources.ts";
import { registerPrompts } from "#src/prompts.ts";
import { createLogger } from "common";

const log = createLogger("mcp/server");

export function createMcpServer(): McpServer {
  log.event("Creating MCP server instance");
  const server = new McpServer({
    name: "personal-assistant-mcp",
    version: "1.0.0",
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);
  log.success("MCP server instance ready");

  return server;
}
