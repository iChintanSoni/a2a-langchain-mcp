/**
 * Agent card definition for the Personal Assistant.
 *
 * The agent card is the A2A protocol's identity document — it describes what
 * the agent can do, which transports it speaks, and where to reach it. Clients
 * fetch it from the well-known `/.well-known/agent.json` endpoint.
 */

import { type AgentCard } from "@a2a-js/sdk";
import { ENV } from "#src/env.ts";

export const agentCard: AgentCard = {
  name: "Personal Assistant",
  description:
    "A personal assistant that answers questions from its own knowledge " +
    "or searches the internet when needed. Supports multi-turn conversations.",
  protocolVersion: "0.3.0",
  version: "0.1.0",
  url: `http://${ENV.CARD_HOST}:${ENV.PORT}/a2a/jsonrpc`,
  skills: [
    {
      id: "chat",
      name: "Chat",
      description: "Ask any question and get a well-researched answer.",
      tags: ["chat", "search", "assistant"],
    },
  ],
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  additionalInterfaces: [
    {
      url: `http://${ENV.CARD_HOST}:${ENV.PORT}/a2a/jsonrpc`,
      transport: "JSONRPC",
    },
    {
      url: `http://${ENV.CARD_HOST}:${ENV.PORT}/a2a/rest`,
      transport: "HTTP+JSON",
    },
    {
      url: `${ENV.CARD_HOST}:${ENV.GRPC_PORT}`,
      transport: "GRPC",
    },
  ],
};
