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

type Agent = Awaited<ReturnType<typeof buildAgent>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message.includes("AbortError") ||
    error.message.includes("aborted")
  );
}

// ─── TaskSession ─────────────────────────────────────────────────────────────

/**
 * Manages the state and protocol events for a single task execution.
 */
class TaskSession {
  private readonly toolQueryMap = new Map<string, { name: string; query: string }>();
  private responseText = "";
  private usageMetadata: any;

  constructor(
    private readonly context: RequestContext,
    private readonly eventBus: ExecutionEventBus,
    private readonly signal: AbortSignal,
    private readonly responseArtifactId = crypto.randomUUID(),
  ) {}

  publishStatus(state: "working" | "completed" | "failed" | "canceled", final = false, error?: unknown) {
    const status: any = { state, timestamp: new Date().toISOString() };
    if (error) {
      status.message = {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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

  private publishArtifact(artifactId: string, name: string, parts: any[], lastChunk = false, metadata?: any) {
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
            : JSON.stringify(tc.args);
        this.toolQueryMap.set(tc.id, { name: tc.name, query });
        console.log(`[executor] Tool execution started: ${tc.name}`);
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

        const rawContent = String(msg.content || "");
        console.log(`[executor] Tool execution finished: ${tool.name}`);

        let resultCount = 0;
        try {
          const parsed = JSON.parse(rawContent);
          resultCount = (Array.isArray(parsed) ? parsed : (parsed.results || [])).length || 0;
        } catch {}

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

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

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
    const session = new TaskSession(requestContext, eventBus, abortController.signal);

    session.publishStatus("working");

    try {
      // 2. Prepare Input (resolve files -> format via MCP prompt)
      let input = await this.prepareInput(requestContext);
      try {
        input = await getMCPPrompt("personal_assistant", { user_question: input });
      } catch (err) {
        console.warn("[executor] MCP prompt failed, using raw input", err);
      }

      // 3. Run Agent
      const agent = await this.getAgent();
      await session.run(agent, input);

      session.publishStatus("completed", true);
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        session.publishStatus("canceled", true);
      } else {
        session.publishStatus("failed", true, error);
        throw error;
      }
    } finally {
      this.abortControllers.delete(taskId);
    }
  }

  private async prepareInput(requestContext: RequestContext): Promise<string> {
    const textInput = getUserInput(requestContext);
    const fileParts = getFileParts(requestContext);

    if (fileParts.length === 0) return textInput;

    console.log(`[executor] Loading ${fileParts.length} files...`);
    const contents = await Promise.all(fileParts.map(async (part) => {
      try {
        const [name, , content] = await loadDocumentContent(part);
        return `--- FILE: ${name} ---\n${content}\n--- END FILE ---`;
      } catch (err) {
        return `--- ERROR LOADING FILE: ${part.file.name} ---`;
      }
    }));

    return `${textInput}\n\nAttached Files:\n${contents.join("\n\n")}`;
  }

  cancelTask = async (taskId: string) => {
    this.abortControllers.get(taskId)?.abort();
  };
}

export default ChatAgentExecutor;
