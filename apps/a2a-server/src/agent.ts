/**
 * Personal assistant agent factory.
 *
 * This module owns everything needed to build a LangChain ReAct agent:
 *  - The Ollama model
 *  - The MCP tool list (fetched from the MCP server)
 *  - A Redis-backed checkpointer for persistent conversation memory
 *
 * The system prompt is loaded from the MCP server's `pa://instructions`
 * resource so that prompt changes in the MCP server are picked up at
 * startup without touching this code.
 *
 * The checkpointer is shared across all requests. Conversation history is kept
 * separate per thread_id, which we set to the A2A contextId so each conversation
 * session gets its own memory thread.
 *
 * Usage:
 *   const agent = await buildAgent(mcpClient);
 *   await agent.stream({ messages: [...] }, { configurable: { thread_id: "..." } });
 */

import { createAgent } from "langchain";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { type MultiServerMCPClient } from "@langchain/mcp-adapters";
import { readResource } from "#src/mcp-client.ts";
import { ENV } from "#src/env.ts";

// ─── Fallback system prompt ───────────────────────────────────────────────────
// Used only when the MCP resource is unreachable at startup.
const FALLBACK_SYSTEM_PROMPT =
  "You are a helpful personal assistant. " +
  "Use the web_search tool for recent events or facts you are unsure about. " +
  "Use the read_url tool to read a specific web page in full. " +
  "Use the get_datetime tool when asked about the current time or date. " +
  "Always cite the source URL when using web search results. " +
  "Be concise and accurate.";

// ─── Factory function ─────────────────────────────────────────────────────────

/**
 * Build and return a LangChain ReAct agent connected to the MCP tool server.
 * Call this once and reuse the returned agent across requests.
 *
 * The system prompt is fetched from the MCP `pa://instructions` resource so
 * the agent always runs with the canonical instructions defined in the MCP server.
 */
export async function buildAgent(mcpClient: MultiServerMCPClient) {
  // RedisSaver.fromUrl() is the correct async factory — there is no constructor.
  // Initialized here since buildAgent is only ever called once (cached in getAgent()).
  const checkpointer = await RedisSaver.fromUrl(ENV.REDIS_URL);

  const tools = await mcpClient.getTools();

  // Load system instructions from the MCP resource.
  // This is the same text surfaced to any MCP client via resources/read.
  let systemPrompt: string;
  try {
    systemPrompt = await readResource("pa://instructions");
    console.log(
      "[agent] System prompt loaded from MCP resource pa://instructions",
    );
  } catch (err) {
    console.warn(
      "[agent] Could not load system prompt from MCP resource; using fallback.",
      err,
    );
    systemPrompt = FALLBACK_SYSTEM_PROMPT;
  }

  return createAgent({
    model: "ollama:qwen3:4b",
    systemPrompt,
    tools,
    checkpointer,
  });
}
