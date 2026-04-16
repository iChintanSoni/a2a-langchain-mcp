/**
 * ChatAgentExecutor – bridges the A2A protocol and the LangChain agent.
 *
 * Responsibilities:
 *  1. Publish A2A task lifecycle events (submitted → working → completed/failed/canceled)
 *  2. Stream agent responses token-by-token via artifact-update events
 *  3. Notify the client when tool calls are in flight (status-update)
 *  4. Support task cancellation via AbortController
 *
 * Agent creation and memory live in agent.ts; this file focuses on protocol glue.
 */

import {
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import { type MultiServerMCPClient } from "@langchain/mcp-adapters";
import { type Task, type Part } from "@a2a-js/sdk";
import { buildAgent } from "#src/agent.ts";
import { getMCPPrompt } from "#src/mcp-client.ts";
import { getUserInput } from "#src/util.ts";

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

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
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

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message.includes("AbortError") ||
    error.message.includes("aborted")
  );
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
            ...(params.resultCount != null
              ? { resultCount: params.resultCount }
              : {}),
            ...(params.error ? { error: params.error } : {}),
          },
        },
      ],
    },
  });
}

async function streamAgentResponse(
  agentInstance: Agent,
  content: string,
  contextId: string,
  taskId: string,
  eventBus: ExecutionEventBus,
  responseArtifactId: string,
  signal?: AbortSignal,
) {
  const stream = await agentInstance.stream(
    { messages: [{ role: "human", content }] },
    {
      configurable: { thread_id: contextId },
      streamMode: ["updates", "messages"],
      signal,
    },
  );

  const toolQueryMap = new Map<string, { toolName: string; query: string }>();
  let responseText = "";
  let usageMetadata: Record<string, unknown> | undefined;

  for await (const chunk of stream) {
    const [mode, payload] = chunk as [string, any];

    if (mode === "messages") {
      const [msgChunk, metadata] = payload;
      if (
        metadata.langgraph_node === "agent" &&
        typeof msgChunk.content === "string" &&
        msgChunk.content.length > 0
      ) {
        responseText += msgChunk.content;
        eventBus.publish({
          kind: "artifact-update",
          taskId,
          contextId,
          append: true,
          lastChunk: false,
          artifact: {
            artifactId: responseArtifactId,
            name: "response",
            parts: [{ kind: "text", text: msgChunk.content }],
          },
        });
      }
    } else if (mode === "updates") {
      const [step, update] = Object.entries(payload)[0] as unknown as [
        string,
        StepUpdate,
      ];
      const messages = update.messages ?? [];
      const lastMsg = messages[messages.length - 1];

      if (step !== "tools" && lastMsg) {
        if (lastMsg.tool_calls?.length) {
          for (const tc of lastMsg.tool_calls) {
            const query =
              typeof tc.args?.query === "string"
                ? tc.args.query
                : JSON.stringify(tc.args);
            toolQueryMap.set(tc.id, { toolName: tc.name, query });
            console.log(`[Tool Call] ${tc.name} executing with args:`, query);
            publishToolCallEvent(eventBus, {
              taskId,
              contextId,
              artifactId: tc.id,
              phase: "running",
              toolName: tc.name,
              query,
            });
          }
        }

        if (lastMsg.usage_metadata) {
          usageMetadata = lastMsg.usage_metadata;
          console.log(`[Observatory - Token Usage]`, lastMsg.usage_metadata);
        }
      } else if (step === "tools") {
        for (const msg of messages) {
          if (!msg.tool_call_id) continue;
          const { toolName: resolvedToolName, query } = toolQueryMap.get(
            msg.tool_call_id,
          ) ?? {
            toolName: "unknown",
            query: "",
          };
          toolQueryMap.delete(msg.tool_call_id);

          const rawContent = typeof msg.content === "string" ? msg.content : "";
          console.log(
            `[Tool Result] ${resolvedToolName}:`,
            rawContent.substring(0, 200) + (rawContent.length > 200 ? "..." : ""),
          );

          let resultCount = 0;
          try {
            const parsed = JSON.parse(rawContent) as Record<string, unknown>;
            const results = Array.isArray(parsed) ? parsed : parsed.results;
            resultCount = Array.isArray(results) ? results.length : 0;
          } catch {
            // non-JSON content
          }
          publishToolCallEvent(eventBus, {
            taskId,
            contextId,
            artifactId: msg.tool_call_id,
            phase: "done",
            toolName: resolvedToolName,
            query,
            resultCount,
          });
        }
      }
    }
  }

  return { responseText, usageMetadata };
}

class ChatAgentExecutor implements AgentExecutor {
  private agent: Agent | undefined;
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly mcpClient: MultiServerMCPClient) {}

  private async getAgent(): Promise<Agent> {
    if (!this.agent) {
      this.agent = await buildAgent(this.mcpClient);
    }
    return this.agent;
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId, userMessage, task } = requestContext;

    if (!task) {
      const newTask: Task = {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [userMessage],
      };
      eventBus.publish(newTask);
    }

    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: { state: "working", timestamp: new Date().toISOString() },
      final: false,
    });

    const textInput = getUserInput(requestContext);
    if (!textInput) throw new Error("No text input in request");

    const agent = await this.getAgent();
    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);

    let formattedInput = textInput;
    try {
      formattedInput = await getMCPPrompt("personal_assistant", {
        user_question: textInput,
      });
    } catch {
      // Non-fatal
    }

    try {
      const responseArtifactId = crypto.randomUUID();

      const result = await streamAgentResponse(
        agent,
        formattedInput,
        contextId,
        taskId,
        eventBus,
        responseArtifactId,
        abortController.signal,
      );

      let responseText = result.responseText;
      const { usageMetadata } = result;

      if (!responseText) {
        responseText = "The agent completed the task without returning text.";
      }

      eventBus.publish({
        kind: "artifact-update",
        taskId,
        contextId,
        append: false,
        lastChunk: true,
        artifact: {
          artifactId: responseArtifactId,
          name: "response",
          description: "Agent response",
          parts: [{ kind: "text", text: responseText }],
          metadata: usageMetadata ? { usage: usageMetadata } : undefined,
        },
      });

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId,
        status: { state: "completed", timestamp: new Date().toISOString() },
        final: true,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: { state: "canceled", timestamp: new Date().toISOString() },
          final: true,
        });
      } else {
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
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
          final: true,
        });
        throw error;
      }
    } finally {
      this.abortControllers.delete(taskId);
    }
  }

  cancelTask = async (
    taskId: string,
    _eventBus: ExecutionEventBus,
  ): Promise<void> => {
    this.abortControllers.get(taskId)?.abort();
  };
}

export default ChatAgentExecutor;
