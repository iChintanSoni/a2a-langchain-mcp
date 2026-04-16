import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ENV } from "#src/env.ts";

const MCP_URL = `http://${ENV.MCP_SERVER_HOST}:${ENV.MCP_SERVER_PORT}/mcp`;

// ── MultiServerMCPClient for tools ────────────────────────────────────────────

function getMCPClient() {
  return new MultiServerMCPClient({
    "mcp-server": {
      transport: "http",
      url: MCP_URL,
    },
  });
}

// ── Raw MCP SDK client for resources and prompts ──────────────────────────────
// A lazily initialized singleton. The MultiServerMCPClient only surfaces tools;
// reading resources and fetching prompts requires a direct SDK Client connection.

let _rawClient: Client | null = null;

async function getRawClient(): Promise<Client> {
  if (_rawClient) return _rawClient;
  const client = new Client({ name: "a2a-server", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  _rawClient = client;
  return client;
}

/**
 * Read a resource from the MCP server by URI.
 * Returns the text content of the first content item, or an empty string.
 */
async function readResource(uri: string): Promise<string> {
  const client = await getRawClient();
  const result = await client.readResource({ uri });
  const first = result.contents[0];
  if (!first || !("text" in first)) return "";
  return first.text as string;
}

/**
 * Fetch a named prompt from the MCP server, fill in the given arguments, and
 * return the rendered message text.
 */
async function getMCPPrompt(
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const client = await getRawClient();
  const result = await client.getPrompt({ name, arguments: args });
  return result.messages
    .map((m) =>
      typeof m.content === "object" && "text" in m.content
        ? (m.content.text as string)
        : "",
    )
    .join("\n");
}

export { getMCPClient, readResource, getMCPPrompt };
