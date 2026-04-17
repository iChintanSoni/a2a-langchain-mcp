/**
 * ChatAgentExecutor bridges the A2A protocol and the LangChain agent.
 *
 * This mirrors the companion a2a-ui demo server's agent executor shape:
 * A2A parts are converted directly into LangChain content, LangGraph updates
 * drive tool-call artifacts, and the final assistant response is published as a
 * single response artifact. Tool implementations still come from the MCP server.
 */

import { type Part } from "@a2a-js/sdk";
import {
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { type MultiServerMCPClient } from "@langchain/mcp-adapters";
import crypto from "node:crypto";
import { buildAgent } from "#src/agent.ts";
import { loadDocumentContent } from "#src/file-loader.ts";
import { getMCPPrompt } from "#src/mcp-client.ts";
import { createLogger } from "common";

type Agent = Awaited<ReturnType<typeof buildAgent>>;
type ToolCall = { id: string; name: string; args: Record<string, unknown> };
type StepUpdate = {
  messages: Array<{
    content: unknown;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    usage_metadata?: Record<string, unknown>;
  }>;
};
type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image_url"; image_url: { url: string } };
type ContentBlock = TextBlock | ImageBlock;
type AgentContent = string | ContentBlock[];
type AgentFactory = (mcpClient: MultiServerMCPClient) => Promise<Agent>;
type PromptRenderer = typeof renderPromptFromMCP;

type ToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string }
  | { type: "image_url"; image_url?: { url?: string } }
  | Record<string, unknown>;

const log = createLogger("a2a/executor");

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message.includes("AbortError") ||
    error.message.includes("aborted")
  );
}

function isFilePart(part: Part): part is Extract<Part, { kind: "file" }> {
  return part.kind === "file";
}

async function renderPromptFromMCP(params: {
  taskId: string;
  contextId: string;
  userQuestion: string;
  context?: string;
}): Promise<string> {
  try {
    const prompt = await getMCPPrompt("chat_agent", {
      user_question: params.userQuestion,
      ...(params.context ? { context: params.context } : {}),
    });
    log.success("Prompt rendered from MCP server", {
      taskId: params.taskId,
      contextId: params.contextId,
    });
    return prompt;
  } catch (err) {
    log.warn("MCP prompt failed, using locally assembled input", err);
    return params.context
      ? `${params.userQuestion}\n\n## Additional Context\n${params.context}`
      : params.userQuestion;
  }
}

async function buildAgentContent(params: {
  taskId: string;
  contextId: string;
  parts: Part[];
  promptRenderer: PromptRenderer;
}): Promise<AgentContent> {
  const textParts = params.parts
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map(part => part.text)
    .filter(Boolean);

  const imageBlocks: ImageBlock[] = [];
  const attachedContexts: string[] = [];

  for (const part of params.parts.filter(isFilePart)) {
    const mimeType = part.file.mimeType ?? "application/octet-stream";

    if (mimeType.startsWith("image/")) {
      const url =
        "uri" in part.file
          ? part.file.uri
          : `data:${mimeType};base64,${"bytes" in part.file ? part.file.bytes : ""}`;
      imageBlocks.push({ type: "image_url", image_url: { url } });
      continue;
    }

    try {
      const [name, loadedMimeType, content] = await loadDocumentContent(part);
      attachedContexts.push(
        `--- FILE: ${name} (${loadedMimeType}) ---\n${content}\n--- END FILE ---`,
      );
      log.success("Loaded attached file for agent context", {
        taskId: params.taskId,
        name,
        mimeType: loadedMimeType,
        contentLength: content.length,
      });
    } catch (err) {
      const name = part.file.name ?? "unnamed_file";
      attachedContexts.push(
        `--- ERROR LOADING FILE: ${name} ---\n${err instanceof Error ? err.message : String(err)}\n--- END FILE ---`,
      );
      log.warn("Failed to load attached file", {
        taskId: params.taskId,
        fileName: name,
      });
    }
  }

  const rawQuestion =
    textParts.join("\n").trim() ||
    (imageBlocks.length > 0 ? "Please respond to the attached image." : "(empty message)");
  const renderedPrompt = await params.promptRenderer({
    taskId: params.taskId,
    contextId: params.contextId,
    userQuestion: rawQuestion,
    context: attachedContexts.length > 0 ? attachedContexts.join("\n\n") : undefined,
  });

  if (imageBlocks.length === 0) return renderedPrompt;
  return [{ type: "text", text: renderedPrompt }, ...imageBlocks];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map(block => {
      if (typeof block === "string") return block;
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    })
    .join("");
}

function normalizeToolContentBlocks(content: unknown): ToolContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content as ToolContentBlock[];
}

function extractImagePayloads(
  blocks: ToolContentBlock[],
): Array<{ bytes: string; mimeType: string }> {
  const payloads: Array<{ bytes: string; mimeType: string }> = [];

  for (const block of blocks) {
    const typedBlock = block as {
      type?: string;
      data?: unknown;
      mimeType?: unknown;
      image_url?: { url?: unknown };
    };

    if (typedBlock.type === "image" && typeof typedBlock.data === "string") {
      payloads.push({
        bytes: typedBlock.data,
        mimeType: typeof typedBlock.mimeType === "string" ? typedBlock.mimeType : "image/png",
      });
      continue;
    }

    if (typedBlock.type === "image_url" && typeof typedBlock.image_url?.url === "string") {
      const url = typedBlock.image_url.url;
      if (!url.startsWith("data:")) continue;

      const commaIndex = url.indexOf(",");
      if (commaIndex === -1) continue;

      const header = url.slice(5, commaIndex);
      const bytes = url.slice(commaIndex + 1);
      const mimeType = header.split(";")[0] || "image/png";
      payloads.push({ bytes, mimeType });
    }
  }

  return payloads;
}

function mimeTypeToExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

function getToolQuery(toolCall: ToolCall): string {
  if (typeof toolCall.args?.query === "string") return toolCall.args.query;
  if (typeof toolCall.args?.prompt === "string") return toolCall.args.prompt;
  return JSON.stringify(toolCall.args);
}

function getToolResultCount(rawContent: string, imageCount: number): number {
  if (imageCount > 0) return imageCount;

  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown> | unknown[];
    const results = Array.isArray(parsed) ? parsed : parsed.results;
    return Array.isArray(results) ? results.length : 0;
  } catch {
    return 0;
  }
}

function publishToolCallEvent(
  eventBus: ExecutionEventBus,
  params: {
    taskId: string;
    contextId: string;
    artifactId: string;
    phase: "running" | "done" | "error";
    toolName: string;
    query: string;
    resultCount?: number;
    error?: string;
  },
) {
  eventBus.publish({
    kind: "artifact-update",
    taskId: params.taskId,
    contextId: params.contextId,
    append: false,
    lastChunk: params.phase !== "running",
    artifact: {
      artifactId: params.artifactId,
      name: "tool-call",
      parts: [
        {
          kind: "data",
          data: {
            phase: params.phase,
            toolName: params.toolName,
            query: params.query,
            ...(params.resultCount != null ? { resultCount: params.resultCount } : {}),
            ...(params.error ? { error: params.error } : {}),
          },
        },
      ],
    },
  });
}

function publishGeneratedImages(
  eventBus: ExecutionEventBus,
  params: {
    taskId: string;
    contextId: string;
    toolCallId: string;
    query: string;
    images: Array<{ bytes: string; mimeType: string }>;
  },
) {
  params.images.forEach((image, index) => {
    const ext = mimeTypeToExtension(image.mimeType);
    eventBus.publish({
      kind: "artifact-update",
      taskId: params.taskId,
      contextId: params.contextId,
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: `${params.toolCallId}:${index}`,
        name: "generated-image",
        description: `Generated image for: ${params.query}`,
        parts: [
          {
            kind: "file",
            file: {
              name: `generated-image.${ext}`,
              mimeType: image.mimeType,
              bytes: image.bytes,
            },
          },
        ],
      },
    });
  });
}

class ChatAgentExecutor implements AgentExecutor {
  private agent: Agent | undefined;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly activeContextIds = new Map<string, string>();
  private readonly activeCancelledTasks = new Set<string>();

  constructor(
    private readonly mcpClient: MultiServerMCPClient,
    private readonly agentFactory: AgentFactory = buildAgent,
    private readonly promptRenderer: PromptRenderer = renderPromptFromMCP,
  ) {}

  private async getAgent(): Promise<Agent> {
    if (!this.agent) this.agent = await this.agentFactory(this.mcpClient);
    return this.agent;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    const parts = userMessage.parts as Part[];
    const content = await buildAgentContent({
      taskId,
      contextId,
      parts,
      promptRenderer: this.promptRenderer,
    });

    log.event("Task initiated", {
      taskId,
      contextId,
      partCount: userMessage.parts.length,
    });

    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: { state: "submitted", timestamp: new Date().toISOString() },
      history: [userMessage],
    });

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      final: false,
      status: { state: "working", timestamp: new Date().toISOString() },
    });

    const abortController = new AbortController();
    this.activeAbortControllers.set(taskId, abortController);
    this.activeContextIds.set(taskId, contextId);

    try {
      const agent = await this.getAgent();
      const { responseText, usageMetadata } = await this.streamAgentResponse(
        agent,
        content,
        contextId,
        taskId,
        eventBus,
        abortController.signal,
      );

      eventBus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: "response",
          description: "Agent response",
          parts: [
            {
              kind: "text",
              text: responseText || "The agent completed the task without returning text.",
            },
          ],
          metadata: usageMetadata ? { usage: usageMetadata } : undefined,
        },
      });

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        final: true,
        status: { state: "completed", timestamp: new Date().toISOString() },
      });
      log.success("Task completed", { taskId, contextId });
    } catch (error) {
      if (this.activeCancelledTasks.has(taskId) || isAbortError(error)) {
        log.warn("Task canceled", { taskId, contextId });
        // cancelTask() already published the canceled status and called eventBus.finished()
        return;
      }

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        final: true,
        status: {
          state: "failed",
          timestamp: new Date().toISOString(),
          message: {
            kind: "message",
            messageId: crypto.randomUUID(),
            role: "agent",
            parts: [
              {
                kind: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          },
        },
      });
      log.error("Task failed", error);
    } finally {
      // Capture before deleting — cancelTask() already called eventBus.finished()
      const wasCanceled = this.activeCancelledTasks.has(taskId);
      this.activeAbortControllers.delete(taskId);
      this.activeContextIds.delete(taskId);
      this.activeCancelledTasks.delete(taskId);
      if (!wasCanceled) eventBus.finished();
    }
  }

  private async streamAgentResponse(
    agent: Agent,
    content: AgentContent,
    contextId: string,
    taskId: string,
    eventBus: ExecutionEventBus,
    signal: AbortSignal,
  ): Promise<{
    responseText: string;
    usageMetadata?: Record<string, unknown>;
  }> {
    const stream = await agent.stream(
      { messages: [{ role: "human", content }] },
      {
        configurable: { thread_id: contextId },
        streamMode: "updates",
        signal,
      },
    );

    const toolQueryMap = new Map<string, { toolName: string; query: string }>();
    let responseText = "";
    let usageMetadata: Record<string, unknown> | undefined;

    for await (const chunk of stream) {
      const [step, update] = Object.entries(chunk)[0] as [string, StepUpdate];
      const messages = update.messages ?? [];
      const lastMsg = messages[messages.length - 1];

      if (step !== "tools" && lastMsg) {
        if (lastMsg.tool_calls?.length) {
          for (const toolCall of lastMsg.tool_calls) {
            const query = getToolQuery(toolCall);
            toolQueryMap.set(toolCall.id, {
              toolName: toolCall.name,
              query,
            });
            log.event("Tool execution started", {
              taskId,
              toolName: toolCall.name,
              query,
            });
            publishToolCallEvent(eventBus, {
              taskId,
              contextId,
              artifactId: toolCall.id,
              phase: "running",
              toolName: toolCall.name,
              query,
            });
          }
        } else {
          const text = contentToText(lastMsg.content);
          if (text) responseText = text;
        }

        if (lastMsg.usage_metadata) usageMetadata = lastMsg.usage_metadata;
        continue;
      }

      if (step !== "tools") continue;

      for (const msg of messages) {
        if (!msg.tool_call_id) continue;

        const { toolName, query } = toolQueryMap.get(msg.tool_call_id) ?? {
          toolName: "unknown",
          query: "",
        };
        toolQueryMap.delete(msg.tool_call_id);

        const contentBlocks = normalizeToolContentBlocks(msg.content);
        const rawContent =
          typeof msg.content === "string"
            ? msg.content
            : contentBlocks.length > 0
              ? JSON.stringify(contentBlocks)
              : "";
        const images = extractImagePayloads(contentBlocks);

        if (images.length > 0) {
          publishGeneratedImages(eventBus, {
            taskId,
            contextId,
            toolCallId: msg.tool_call_id,
            query,
            images,
          });
        }

        publishToolCallEvent(eventBus, {
          taskId,
          contextId,
          artifactId: msg.tool_call_id,
          phase: "done",
          toolName,
          query,
          resultCount: getToolResultCount(rawContent, images.length),
        });
        log.success("Tool execution finished", { taskId, toolName });
      }
    }

    return { responseText, usageMetadata };
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const controller = this.activeAbortControllers.get(taskId);
    this.activeCancelledTasks.add(taskId);
    if (controller) controller.abort();

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId: this.activeContextIds.get(taskId) ?? taskId,
      final: true,
      status: { state: "canceled", timestamp: new Date().toISOString() },
    });
    eventBus.finished();

    if (!controller) this.activeCancelledTasks.delete(taskId);
  }
}

export default ChatAgentExecutor;
