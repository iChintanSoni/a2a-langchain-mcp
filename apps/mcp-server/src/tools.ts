/**
 * Tool implementations and MCP registrations for the personal assistant.
 *
 * Each function below is the logic behind one MCP tool. `registerTools`
 * wires them into a McpServer instance using the non-deprecated `registerTool`
 * API. Keeping both implementation and registration here means you can read a
 * tool's description, schema, and logic in one place.
 *
 * No external search packages are used — web_search calls DuckDuckGo's HTML
 * endpoint directly via fetch, which is available in Node 18+.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ─── web_search ───────────────────────────────────────────────────────────────

/**
 * Search the web via DuckDuckGo's HTML endpoint. No API key needed.
 * Parses result titles, redirect URLs, and snippets from the response HTML.
 */
async function webSearch(
  query: string,
  maxResults: number = 5,
): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query, kl: "us-en" });
  const response = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (compatible; PersonalAssistant/1.0)",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }

  const html = await response.text();
  const results: SearchResult[] = [];

  // Each result block looks like:
  //   <a class="result__a" href="/l/?uddg=ENCODED_URL&...">Title</a>
  //   <a class="result__snippet">Snippet text</a>
  const resultBlocks = html.split('<div class="result ');

  for (const block of resultBlocks.slice(1)) {
    if (results.length >= maxResults) break;

    const titleMatch = block.match(
      /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    const snippetMatch = block.match(
      /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
    );

    if (!titleMatch) continue;

    const rawHref = titleMatch[1];
    const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    // DDG wraps the real URL in a redirect — extract it from the `uddg` param.
    let url = rawHref;
    try {
      const params = new URL(
        rawHref.startsWith("/") ? `https://duckduckgo.com${rawHref}` : rawHref,
      ).searchParams;
      url = decodeURIComponent(params.get("uddg") ?? rawHref);
    } catch {
      // keep the raw href if parsing fails
    }

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

// ─── read_url ─────────────────────────────────────────────────────────────────

/**
 * Fetch a URL and return its readable plain-text content.
 * HTML tags, scripts, and styles are stripped so the agent only sees text.
 */
async function readUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PersonalAssistant/1.0)",
      Accept: "text/html,text/plain,*/*",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  if (!contentType.includes("text/html")) {
    return raw.slice(0, 12_000);
  }

  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 12_000);
}

// ─── get_datetime ─────────────────────────────────────────────────────────────

/**
 * Return the current date and time, formatted for a given IANA timezone.
 */
function getDatetime(timezone: string = "UTC"): string {
  const now = new Date();

  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "long",
    }).format(now);

    return `${formatted}\nISO 8601: ${now.toISOString()}`;
  } catch {
    return `${now.toUTCString()}\nISO 8601: ${now.toISOString()}`;
  }
}

// ─── MCP registration ─────────────────────────────────────────────────────────

/**
 * Register all tools on the given McpServer instance.
 * Called once per session in createMcpServer().
 */
export function registerTools(server: McpServer): void {
  server.registerTool(
    "web_search",
    {
      description:
        "Search the internet with DuckDuckGo. Returns titles, URLs, and snippets.",
      inputSchema: {
        query: z.string().describe("The search query"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Max results to return (1–10, default 5)"),
      },
    },
    async ({ query, max_results }) => {
      const results = await webSearch(query, max_results);

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const text = results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "read_url",
    {
      description: "Fetch and extract the text content of any web page.",
      inputSchema: {
        url: z.url().describe("The URL to fetch"),
      },
    },
    async ({ url }) => {
      const content = await readUrl(url);
      return { content: [{ type: "text", text: content }] };
    },
  );

  server.registerTool(
    "get_datetime",
    {
      description:
        "Get the current date and time. Use this for any time-sensitive question.",
      inputSchema: {
        timezone: z
          .string()
          .optional()
          .describe(
            "IANA timezone (e.g. 'America/New_York'). Defaults to UTC.",
          ),
      },
    },
    ({ timezone }) => {
      const text = getDatetime(timezone);
      return { content: [{ type: "text", text }] };
    },
  );
}
