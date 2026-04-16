/**
 * MCP prompts for the personal assistant.
 *
 * Prompts are reusable message templates that MCP clients fill in with
 * arguments before sending to an LLM. `registerPrompts` wires them into a
 * McpServer instance using the non-deprecated `registerPrompt` API.
 *
 * The `argsSchema` field takes a Zod raw shape (plain object of Zod types)
 * rather than the old array-of-descriptor format.
 *
 * Prompts exposed:
 *  - personal_assistant  Formats a user question (with optional context) into
 *                        a structured message ready for the agent.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── MCP registration ─────────────────────────────────────────────────────────

/**
 * Register all prompts on the given McpServer instance.
 * Called once per session in createMcpServer().
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "personal_assistant",
    {
      description:
        "A ready-to-use prompt template for asking the personal assistant a question.",
      argsSchema: {
        user_question: z.string().describe("The user's question"),
        context: z
          .string()
          .optional()
          .describe("Optional context (e.g. location, preferences)"),
      },
    },
    ({ user_question, context }) => {
      const contextSection = context
        ? `\n\n## Additional Context\n${context}`
        : "";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `You are a knowledgeable and concise personal assistant. ` +
                `Use the available tools (web_search, read_url, get_datetime) when needed. ` +
                `Cite sources when using web results.` +
                contextSection +
                `\n\n## Question\n${user_question}`,
            },
          },
        ],
      };
    },
  );
}
