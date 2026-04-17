import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { AGENT_CARD_PATH, type MessageSendParams } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

process.env.HOST ??= "127.0.0.1";
process.env.CARD_HOST ??= "localhost";
process.env.PORT ??= "4000";
process.env.GRPC_PORT ??= "4001";
process.env.MCP_SERVER_HOST ??= "localhost";
process.env.MCP_SERVER_PORT ??= "5050";

const { createAgentCard } = await import("../src/agent-card.ts");
const { default: ChatAgentExecutor } = await import("../src/agent-executor.ts");

type StreamCall = {
  input: unknown;
  options: {
    configurable?: { thread_id?: string };
    streamMode?: string;
    signal?: AbortSignal;
  };
};

function createFakeAgent(calls: StreamCall[]) {
  return {
    async stream(input: unknown, options: StreamCall["options"]) {
      calls.push({ input, options });

      return (async function* () {
        yield {
          agent: {
            messages: [
              {
                content: "",
                tool_calls: [
                  {
                    id: "tool-call-1",
                    name: "web_search",
                    args: { query: "latest protocol news" },
                  },
                ],
              },
            ],
          },
        };
        yield {
          tools: {
            messages: [
              {
                tool_call_id: "tool-call-1",
                content: JSON.stringify({
                  results: [{ title: "One" }, { title: "Two" }],
                }),
              },
            ],
          },
        };
        yield {
          agent: {
            messages: [
              {
                content: "Final answer from the actual executor",
                usage_metadata: { input_tokens: 11, output_tokens: 7 },
              },
            ],
          },
        };
      })();
    },
  };
}

async function createA2ATestServer() {
  const app = express();
  app.use(express.json());

  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const streamCalls: StreamCall[] = [];
  const executor = new ChatAgentExecutor(
    {} as never,
    async () => createFakeAgent(streamCalls) as never,
    async ({ userQuestion, context }) =>
      context
        ? `Rendered prompt: ${userQuestion}\n\n${context}`
        : `Rendered prompt: ${userQuestion}`,
  );
  const requestHandler = new DefaultRequestHandler(
    createAgentCard(baseUrl),
    new InMemoryTaskStore(),
    executor,
  );

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(
    "/a2a/jsonrpc",
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  app.use("/a2a/rest", restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    baseUrl,
    streamCalls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

test("A2A SDK client exercises ChatAgentExecutor over sendMessage", async () => {
  const server = await createA2ATestServer();

  try {
    const client = await new ClientFactory().createFromUrl(server.baseUrl);
    const params: MessageSendParams = {
      message: {
        kind: "message",
        messageId: "test-message",
        role: "user",
        parts: [{ kind: "text", text: "hello agent" }],
      },
    };

    const result = await client.sendMessage(params);

    assert.equal(result.kind, "task");
    assert.equal(result.status.state, "completed");
    assert.equal(result.history?.[0]?.messageId, "test-message");

    const toolArtifacts = result.artifacts?.filter(artifact => artifact.name === "tool-call") ?? [];
    const responseArtifact = result.artifacts?.find(artifact => artifact.name === "response");

    assert.equal(toolArtifacts.length, 1);
    assert.deepEqual(toolArtifacts[0].parts[0], {
      kind: "data",
      data: {
        phase: "done",
        toolName: "web_search",
        query: "latest protocol news",
        resultCount: 2,
      },
    });
    assert.equal(responseArtifact?.parts[0]?.kind, "text");
    assert.equal(responseArtifact?.parts[0]?.text, "Final answer from the actual executor");
    assert.deepEqual(responseArtifact?.metadata, {
      usage: { input_tokens: 11, output_tokens: 7 },
    });

    assert.equal(server.streamCalls.length, 1);
    assert.deepEqual(server.streamCalls[0].input, {
      messages: [{ role: "human", content: "Rendered prompt: hello agent" }],
    });
    assert.equal(server.streamCalls[0].options.configurable?.thread_id, result.contextId);
    assert.equal(server.streamCalls[0].options.streamMode, "updates");
    assert.ok(server.streamCalls[0].options.signal instanceof AbortSignal);
  } finally {
    await server.close();
  }
});

test("A2A SDK client receives ChatAgentExecutor streaming events", async () => {
  const server = await createA2ATestServer();

  try {
    const client = await new ClientFactory().createFromUrl(server.baseUrl);
    const params: MessageSendParams = {
      message: {
        kind: "message",
        messageId: "stream-message",
        role: "user",
        parts: [{ kind: "text", text: "stream me" }],
      },
    };
    const events = [];

    for await (const event of client.sendMessageStream(params)) {
      events.push(event);
    }

    assert.ok(events.some(event => event.kind === "task"));
    assert.ok(
      events.some(
        event =>
          event.kind === "artifact-update" &&
          event.artifact.name === "tool-call" &&
          event.artifact.parts[0].kind === "data" &&
          event.artifact.parts[0].data.phase === "running",
      ),
    );
    assert.ok(
      events.some(
        event =>
          event.kind === "artifact-update" &&
          event.artifact.name === "response" &&
          event.artifact.parts[0].kind === "text" &&
          event.artifact.parts[0].text === "Final answer from the actual executor",
      ),
    );
    assert.ok(
      events.some(
        event =>
          event.kind === "status-update" &&
          event.final === true &&
          event.status.state === "completed",
      ),
    );
  } finally {
    await server.close();
  }
});
