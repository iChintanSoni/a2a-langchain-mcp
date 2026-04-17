import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "5050";
process.env.TAVILY_API_KEY ??= "test-key";
process.env.OLLAMA_HOST ??= "http://ollama.test";
process.env.OLLAMA_IMAGE_MODEL ??= "image-model";

const originalFetch = globalThis.fetch;
const { createMcpServer } = await import("../src/mcp-server.ts");
const { INSTRUCTIONS } = await import("../src/resources.ts");

async function createClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "mcp-server-test", version: "1.0.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("MCP client can list tools, prompts, and resources from the server", async () => {
  const { client, close } = await createClient();

  try {
    const [{ tools }, { prompts }, { resources }] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
    ]);

    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      "generate_image",
      "get_datetime",
      "read_url",
      "web_search",
    ]);
    assert.deepEqual(
      prompts.map(prompt => prompt.name),
      ["chat_agent"],
    );
    assert.deepEqual(resources, [
      {
        name: "instructions",
        uri: "chat://instructions",
        description: "System instructions for the chat agent.",
        mimeType: "text/plain",
      },
    ]);
  } finally {
    await close();
  }
});

test("MCP client can read instructions and render the chat prompt", async () => {
  const { client, close } = await createClient();

  try {
    const resource = await client.readResource({ uri: "chat://instructions" });
    assert.deepEqual(resource.contents, [{ uri: "chat://instructions", text: INSTRUCTIONS }]);

    const prompt = await client.getPrompt({
      name: "chat_agent",
      arguments: {
        user_question: "What changed?",
        context: "Use the release notes.",
      },
    });
    const text = prompt.messages[0].content.type === "text" ? prompt.messages[0].content.text : "";

    assert.match(text, /web_search/);
    assert.match(text, /## Additional Context\nUse the release notes\./);
    assert.match(text, /## Question\nWhat changed\?/);
  } finally {
    await close();
  }
});

test("MCP client can call web_search through the official protocol client", async () => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://api.tavily.com/search");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");

    return Response.json({
      results: [
        { title: "One", url: "https://one.test", content: "First" },
        { title: "Missing URL", content: "ignored" },
      ],
    });
  }) as typeof fetch;

  const { client, close } = await createClient();

  try {
    const result = await client.callTool({
      name: "web_search",
      arguments: { query: "node test runner", max_results: 2 },
    });

    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /\[1\] One\nURL: https:\/\/one\.test\nFirst/);
    assert.doesNotMatch(result.content[0].text, /Missing URL/);
  } finally {
    await close();
  }
});

test("MCP client can call read_url and receive extracted page text", async () => {
  globalThis.fetch = (async () =>
    new Response(
      "<html><style>.x{}</style><script>alert(1)</script><body>A&nbsp;&amp;&lt;&gt;&quot; B</body></html>",
      { headers: { "content-type": "text/html" } },
    )) as typeof fetch;

  const { client, close } = await createClient();

  try {
    const result = await client.callTool({
      name: "read_url",
      arguments: { url: "https://example.test" },
    });

    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[0].text, 'A &<>" B');
  } finally {
    await close();
  }
});

test("MCP client can call generate_image and receive image content", async () => {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "http://ollama.test/v1/images/generations");
    assert.deepEqual(JSON.parse(init?.body as string), {
      model: "image-model",
      prompt: "a small owl",
      size: "1024x1024",
      response_format: "b64_json",
    });

    return Response.json({
      data: [{ b64_json: "data:image/png;base64,aW1hZ2U=" }],
    });
  }) as typeof fetch;

  const { client, close } = await createClient();

  try {
    const result = await client.callTool({
      name: "generate_image",
      arguments: { prompt: "a small owl" },
    });

    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].data, "aW1hZ2U=");
    assert.equal(result.content[1].mimeType, "image/png");
    assert.deepEqual(result.structuredContent, {
      success: true,
      provider: "ollama",
      mimeType: "image/png",
      fileName: "generated-image.png",
    });
  } finally {
    await close();
  }
});

test("MCP client can call get_datetime", async () => {
  const { client, close } = await createClient();

  try {
    const result = await client.callTool({
      name: "get_datetime",
      arguments: { timezone: "UTC" },
    });

    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /ISO 8601:/);
  } finally {
    await close();
  }
});
