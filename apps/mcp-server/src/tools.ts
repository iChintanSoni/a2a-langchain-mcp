/**
 * Tool implementations and MCP registrations for the Chat Agent.
 *
 * Each function below is the logic behind one MCP tool. `registerTools`
 * wires them into a McpServer instance using the non-deprecated `registerTool`
 * API. Keeping both implementation and registration here means you can read a
 * tool's description, schema, and logic in one place.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLogger } from "common";
import { ENV } from "#src/env.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const log = createLogger("mcp/tools");

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
};

type OllamaImageGenerationResponse = {
  data?: Array<{
    b64_json?: string;
  }>;
};

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }

  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
    .join("\n\n---\n\n");
}

// ─── web_search ───────────────────────────────────────────────────────────────

/**
 * Search the web via Tavily's search API.
 */
async function webSearch(query: string, maxResults: number = 5): Promise<SearchResult[]> {
  log.event("web_search started", { query, maxResults });

  if (!ENV.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${ENV.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    log.error("web_search failed", { query, status: response.status });
    throw new Error(`Tavily search failed: ${response.status}`);
  }

  const data = (await response.json()) as TavilySearchResponse;
  const results = (data.results ?? [])
    .filter(
      (
        result,
      ): result is Required<Pick<SearchResult, "title" | "url">> & {
        content?: string;
      } => typeof result.title === "string" && typeof result.url === "string",
    )
    .slice(0, maxResults)
    .map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.content ?? "",
    }));

  log.success("web_search completed", { query, resultCount: results.length });
  return results;
}

// ─── generate_image ──────────────────────────────────────────────────────────

function getMimeExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? "png";
  return subtype.includes("png") ? "png" : subtype;
}

async function generateImage(
  prompt: string,
): Promise<
  | { success: true; imageBase64: string; mimeType: string; provider: string }
  | { success: false; error: string }
> {
  log.event("generate_image started", { provider: "ollama" });

  try {
    const response = await fetch(`${ENV.OLLAMA_HOST}/v1/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ENV.OLLAMA_IMAGE_MODEL,
        prompt,
        size: "1024x1024",
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: `Ollama image generation failed: ${body}` };
    }

    const data = (await response.json()) as OllamaImageGenerationResponse;
    let base64Image = data.data?.[0]?.b64_json;

    if (!base64Image) {
      return { success: false, error: "No image was returned by Ollama." };
    }

    if (base64Image.startsWith("data:")) {
      base64Image = base64Image.split(",")[1] ?? base64Image;
    }

    return {
      success: true,
      imageBase64: base64Image,
      mimeType: "image/png",
      provider: "ollama",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── read_url ─────────────────────────────────────────────────────────────────

/**
 * Return true if the hostname resolves to a private/loopback/link-local address
 * that should never be reachable from a public agent (SSRF guard).
 */
function isPrivateHostname(hostname: string): boolean {
  // Strip IPv6 brackets
  const host = hostname.replace(/^\[|\]$/g, "");

  // Loopback
  if (host === "localhost" || host === "::1") return true;

  // Plain IPv4
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [, a, b, c] = ipv4.map(Number);
    return (
      a === 10 || // 10.0.0.0/8
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      a === 127 || // 127.0.0.0/8
      (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
      (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 (carrier-grade NAT)
    );
  }

  return false;
}

/**
 * Fetch a URL and return its readable plain-text content.
 * HTML tags, scripts, and styles are stripped so the agent only sees text.
 */
async function readUrl(url: string): Promise<string> {
  const parsed = new URL(url);
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`Fetching private/internal addresses is not allowed: ${parsed.hostname}`);
  }
  log.event("read_url started", { url });
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PersonalAssistant/1.0)",
      Accept: "text/html,text/plain,*/*",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    log.error("read_url failed", {
      url,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();

  if (!contentType.includes("text/html")) {
    const content = raw.slice(0, 12_000);
    log.success("read_url completed", {
      url,
      contentType,
      contentLength: content.length,
    });
    return content;
  }

  const content = raw
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
  log.success("read_url completed", {
    url,
    contentType,
    contentLength: content.length,
  });
  return content;
}

// ─── get_datetime ─────────────────────────────────────────────────────────────

/**
 * Return the current date and time, formatted for a given IANA timezone.
 */
function getDatetime(timezone: string = "UTC"): string {
  log.event("get_datetime started", { timezone });
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

    const text = `${formatted}\nISO 8601: ${now.toISOString()}`;
    log.success("get_datetime completed", { timezone });
    return text;
  } catch {
    const text = `${now.toUTCString()}\nISO 8601: ${now.toISOString()}`;
    log.warn("get_datetime fell back to UTC", { timezone });
    return text;
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
      description: "Search the internet with Tavily. Returns titles, URLs, and snippets.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
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

      return {
        content: [{ type: "text", text: formatSearchResults(results) }],
      };
    },
  );

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image from a text prompt. Use this when the user asks to create, draw, render, or generate an image.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        prompt: z.string().describe("The text description of the image to generate"),
      },
    },
    async ({ prompt }) => {
      const result = await generateImage(prompt);

      if (!result.success) {
        return {
          isError: true,
          content: [{ type: "text", text: result.error }],
        };
      }

      const mimeType = result.mimeType;
      const ext = getMimeExtension(mimeType);

      return {
        content: [
          { type: "text", text: `Generated image with ${result.provider} for: ${prompt}` },
          {
            type: "image",
            data: result.imageBase64,
            mimeType,
          },
        ],
        structuredContent: {
          success: true,
          provider: result.provider,
          mimeType,
          fileName: `generated-image.${ext}`,
        },
      };
    },
  );

  server.registerTool(
    "read_url",
    {
      description: "Fetch and extract the text content of any web page.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
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
      description: "Get the current date and time. Use this for any time-sensitive question.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone (e.g. 'America/New_York'). Defaults to UTC."),
      },
    },
    ({ timezone }) => {
      const text = getDatetime(timezone);
      return { content: [{ type: "text", text }] };
    },
  );
}
