/**
 * MCP resources for the Chat Agent.
 *
 * Resources are read-only data that MCP clients (e.g. the agent) can fetch on
 * demand. `registerResources` wires them into a McpServer instance using the
 * non-deprecated `registerResource` API.
 *
 * Resources exposed:
 *  - chat://instructions  System instructions that tell the agent how to
 *                         behave and when to use each tool.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "common";

const log = createLogger("mcp/resources");

// ─── Content ──────────────────────────────────────────────────────────────────

export const INSTRUCTIONS = `# Chat Agent - Capabilities

You are a knowledgeable chat agent. Answer questions using your own knowledge
and the tools below when needed.

## Tools

| Tool            | When to use                                                   |
|-----------------|---------------------------------------------------------------|
| web_search      | Current events, facts you are unsure about, recent news       |
| read_url        | Read a specific web page or article in full                   |
| get_datetime    | The user asks about the current date or time                  |
| generate_image  | The user asks to create, draw, render, or generate an image   |

## Guidelines
- Answer from your own knowledge first when the information is not time-sensitive.
- Search the web for recent or rapidly-changing information.
- Always cite the source URL when using results from web_search or read_url.
- When using generate_image, return the generated image as the primary result
  and include a brief text description of what was created.
- Be concise and accurate. If unsure, say so.`;

// ─── MCP registration ─────────────────────────────────────────────────────────

/**
 * Register all resources on the given McpServer instance.
 * Called once per session in createMcpServer().
 */
export function registerResources(server: McpServer): void {
  server.registerResource(
    "instructions",
    "chat://instructions",
    {
      description: "System instructions for the chat agent.",
      mimeType: "text/plain",
    },
    (_uri) => {
      log.event("instructions resource requested");
      log.success("instructions resource served");
      return {
        contents: [{ uri: "chat://instructions", text: INSTRUCTIONS }],
      };
    },
  );
}
