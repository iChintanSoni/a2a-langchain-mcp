import { ClientFactory } from "@a2a-js/sdk/client";
import { Message, MessageSendParams, SendMessageSuccessResponse } from "@a2a-js/sdk";
import { v4 as uuidv4 } from "uuid";
import { ENV } from "#src/env.ts";

async function run() {
  const factory = new ClientFactory();

  // createFromUrl accepts baseUrl and optional path,
  // (the default path is /.well-known/agent-card.json)
  const client = await factory.createFromUrl(`http://${ENV.HOST}:${ENV.PORT}`);

  const sendParams: MessageSendParams = {
    message: {
      messageId: uuidv4(),
      role: "user",
      parts: [{ kind: "text", text: "Hi there!" }],
      kind: "message",
    },
  };

  try {
    const response = await client.sendMessage(sendParams);
    if (response.kind == "task") {
      console.log("Task response:", response.status.message);
    } else {
      console.log("Message response:", response);
    }
  } catch (e) {
    console.error("Error:", e);
  }
}

await run();
