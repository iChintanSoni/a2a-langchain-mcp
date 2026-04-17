/**
 * ChatAgentExecutor – bridges the A2A protocol and the LangChain agent.
 *
 * Responsibilities:
 *  1. Publish A2A task lifecycle events (submitted → working → completed/failed/canceled)
 *  2. Stream agent responses token-by-token via artifact-update events
 *  3. Notify the client when tool calls are in flight
 *  4. Support task cancellation via AbortController
 *
 * This file focuses on protocol "glue". Agent creation and memory live in agent.ts.
 */

import {
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { type MultiServerMCPClient } from "@langchain/mcp-adapters";
import { type Task } from "@a2a-js/sdk";
import { buildAgent } from "#src/agent.ts";
import { getFileParts, getUserInput } from "#src/util.ts";
import { loadDocumentContent } from "#src/file-loader.ts";
import { getMCPPrompt } from "#src/mcp-client.ts";
import crypto from "node:crypto";
import { createLogger } from "common";

type Agent = Awaited<ReturnType<typeof buildAgent>>;
const log = createLogger("a2a/executor");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message.includes("AbortError") ||
    error.message.includes("aborted")
  );
}

type ToolContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      data: string;
      mimeType?: string;
    }
  | {
      type: "image_url";
      image_url?: { url?: string };
    }
  | Record<string, unknown>;

function normalizeToolContentBlocks(content: unknown): ToolContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
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
        mimeType:
          typeof typedBlock.mimeType === "string"
            ? typedBlock.mimeType
            : "image/png",
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

// ─── TaskSession ─────────────────────────────────────────────────────────────

/**
 * Manages the state and protocol events for a single task execution.
 */
class TaskSession {
  private readonly toolQueryMap = new Map<
    string,
    { name: string; query: string }
  >();
  private responseText = "";
  private usageMetadata: any;

  constructor(
    private readonly context: RequestContext,
    private readonly eventBus: ExecutionEventBus,
    private readonly signal: AbortSignal,
    private readonly responseArtifactId = crypto.randomUUID(),
  ) {}

  publishStatus(
    state: "working" | "completed" | "failed" | "canceled",
    final = false,
    error?: unknown,
  ) {
    const status: any = { state, timestamp: new Date().toISOString() };
    if (error) {
      status.message = {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [
          {
            kind: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
    this.eventBus.publish({
      kind: "status-update",
      taskId: this.context.taskId,
      contextId: this.context.contextId,
      status,
      final,
    });
  }

  private publishArtifact(
    artifactId: string,
    name: string,
    parts: any[],
    lastChunk = false,
    metadata?: any,
  ) {
    this.eventBus.publish({
      kind: "artifact-update",
      taskId: this.context.taskId,
      contextId: this.context.contextId,
      append: !lastChunk,
      lastChunk,
      artifact: { artifactId, name, parts, metadata },
    });
  }

  async run(agent: Agent, input: string) {
    log.event("Starting agent stream", {
      taskId: this.context.taskId,
      contextId: this.context.contextId,
    });
    const stream = await agent.stream(
      { messages: [{ role: "human", content: input }] },
      {
        configurable: { thread_id: this.context.contextId },
        streamMode: ["messages", "updates"],
        signal: this.signal,
      },
    );

    for await (const chunk of stream) {
      const [mode, payload] = chunk as [string, any];

      if (mode === "messages") {
        this.handleMessageChunk(payload);
      } else if (mode === "updates") {
        this.handleStepUpdate(payload);
      }
    }

    this.finalizeResponse();
    log.success("Agent stream finished", {
      taskId: this.context.taskId,
      contextId: this.context.contextId,
    });
  }

  /**
   * handleMessageChunk processes token-by-token message increments.
   * payload is [messageChunk, metadata]
   */
  private handleMessageChunk(payload: any) {
    const [msgChunk, metadata] = payload;

    // Only stream content from the "agent" node to the user.
    if (metadata.langgraph_node === "agent" && msgChunk.content) {
      this.responseText += msgChunk.content;
      this.publishArtifact(this.responseArtifactId, "response", [
        { kind: "text", text: msgChunk.content },
      ]);
    }
  }

  /**
   * handleStepUpdate processes full node outputs (steps).
   * payload is { [nodeName]: { messages: [...] } }
   */
  private handleStepUpdate(payload: any) {
    const nodeName = Object.keys(payload)[0];
    const update = payload[nodeName];
    const messages = update.messages ?? [];
    const lastMsg = messages[messages.length - 1];

    if (!lastMsg) return;

    // 1. Tool Call Initialization
    if (nodeName === "agent" && lastMsg.tool_calls?.length > 0) {
      for (const tc of lastMsg.tool_calls) {
        const query =
          typeof tc.args?.query === "string"
            ? tc.args.query
            : typeof tc.args?.prompt === "string"
              ? tc.args.prompt
            : JSON.stringify(tc.args);
        this.toolQueryMap.set(tc.id, { name: tc.name, query });
        log.event("Tool execution started", {
          taskId: this.context.taskId,
          toolName: tc.name,
          query,
        });
        this.publishArtifact(tc.id, "tool-call", [
          {
            kind: "data",
            data: { phase: "running", toolName: tc.name, query },
          },
        ]);
      }
    }

    // 2. Tool Result Collection
    if (nodeName === "tools") {
      for (const msg of messages) {
        if (!msg.tool_call_id) continue;
        const tool = this.toolQueryMap.get(msg.tool_call_id) ?? {
          name: "unknown",
          query: "",
        };
        this.toolQueryMap.delete(msg.tool_call_id);

        const contentBlocks = normalizeToolContentBlocks(msg.content);
        const rawContent =
          typeof msg.content === "string"
            ? msg.content
            : contentBlocks.length > 0
              ? JSON.stringify(contentBlocks)
              : "";
        log.success("Tool execution finished", {
          taskId: this.context.taskId,
          toolName: tool.name,
        });

        const imagePayloads = extractImagePayloads(contentBlocks);
        if (imagePayloads.length > 0) {
          imagePayloads.forEach((image, index) => {
            const ext = mimeTypeToExtension(image.mimeType);
            this.publishArtifact(
              `${msg.tool_call_id}:${index}`,
              "generated-image",
              [
                {
                  kind: "file",
                  file: {
                    name: `generated-image.${ext}`,
                    mimeType: image.mimeType,
                    bytes: image.bytes,
                  },
                },
              ],
              true,
            );
          });
        }

        let resultCount = 0;
        try {
          const parsed = JSON.parse(rawContent);
          resultCount =
            (Array.isArray(parsed) ? parsed : parsed.results || []).length || 0;
        } catch {}
        if (imagePayloads.length > 0) {
          resultCount = imagePayloads.length;
        }

        this.publishArtifact(
          msg.tool_call_id,
          "tool-call",
          [
            {
              kind: "data",
              data: {
                phase: "done",
                toolName: tool.name,
                query: tool.query,
                resultCount,
              },
            },
          ],
          true,
        );
      }
    }

    // 3. Global Usage Metadata (usually comes from the LLM after finishing)
    if (lastMsg.usage_metadata) {
      this.usageMetadata = lastMsg.usage_metadata;
    }
  }

  private finalizeResponse() {
    this.publishArtifact(
      this.responseArtifactId,
      "response",
      [
        {
          kind: "text",
          text:
            this.responseText ||
            "The agent completed the task without returning text.",
        },
      ],
      true,
      this.usageMetadata ? { usage: this.usageMetadata } : undefined,
    );
  }
}

// ─── ChatAgentExecutor ────────────────────────────────────────────────────────

class ChatAgentExecutor implements AgentExecutor {
  private agent: Agent | undefined;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly mcpClient: MultiServerMCPClient) {}

  private async getAgent() {
    if (!this.agent) this.agent = await buildAgent(this.mcpClient);
    return this.agent;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    log.event("Task received", {
      taskId,
      contextId,
      hasExistingTask: Boolean(task),
    });

    // 1. Ensure task exists and transition to "working"
    if (!task) {
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
      } as Task);
    }

    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);
    const session = new TaskSession(
      requestContext,
      eventBus,
      abortController.signal,
    );

    session.publishStatus("working");
    log.info("Task marked working", { taskId, contextId });

    try {
      // 2. Prepare Input (resolve files -> format via MCP prompt)
      let input = await this.prepareInput(requestContext);
      try {
        input = await getMCPPrompt("chat_agent", {
          user_question: input,
        });
        log.success("Prompt rendered from MCP server", {
          taskId,
          contextId,
        });
      } catch (err) {
        log.warn("MCP prompt failed, using raw input", err);
      }

      // 3. Run Agent
      const agent = await this.getAgent();
      log.debug("Agent instance ready", { taskId, contextId });
      await session.run(agent, input);

      session.publishStatus("completed", true);
      log.success("Task completed", { taskId, contextId });
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        session.publishStatus("canceled", true);
        log.warn("Task canceled", { taskId, contextId });
      } else {
        session.publishStatus("failed", true, error);
        log.error("Task failed", error);
        throw error;
      }
    } finally {
      this.abortControllers.delete(taskId);
      log.debug("Task session cleaned up", { taskId, contextId });
    }
  }

  private async prepareInput(requestContext: RequestContext): Promise<string> {
    const textInput = getUserInput(requestContext);
    const fileParts = getFileParts(requestContext);

    log.info("Preparing task input", {
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      textLength: textInput.length,
      fileCount: fileParts.length,
    });

    if (fileParts.length === 0) return textInput;

    log.event("Loading attached files", {
      taskId: requestContext.taskId,
      fileCount: fileParts.length,
    });
    const contents = await Promise.all(
      fileParts.map(async (part) => {
        try {
          const [name, mimeType, content] = await loadDocumentContent(part);
          log.success("Loaded file content", {
            taskId: requestContext.taskId,
            name,
            mimeType,
            contentLength: content.length,
          });
          return `--- FILE: ${name} ---\n${content}\n--- END FILE ---`;
        } catch (err) {
          log.warn("Failed to load attached file", {
            taskId: requestContext.taskId,
            fileName: part.file.name,
          });
          return `--- ERROR LOADING FILE: ${part.file.name} ---`;
        }
      }),
    );

    return `${textInput}\n\nAttached Files:\n${contents.join("\n\n")}`;
  }

  cancelTask = async (taskId: string) => {
    this.abortControllers.get(taskId)?.abort();
  };
}

export default ChatAgentExecutor;
