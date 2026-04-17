/**
 * Agent card definition for the Chat Agent.
 *
 * The agent card is the A2A protocol's identity document — it describes what
 * the agent can do, which transports it speaks, and where to reach it. Clients
 * fetch it from the well-known `/.well-known/agent.json` endpoint.
 */

import { type AgentCard } from "@a2a-js/sdk";
import { ENV } from "#src/env.ts";

export const agentCard: AgentCard = {
  name: "Chat Agent",
  description:
    "A conversational A2A agent with search, image input, and image generation.",
  protocolVersion: "0.3.0",
  version: "1.0.0",
  preferredTransport: "JSONRPC",
  url: `http://${ENV.CARD_HOST}:${ENV.PORT}/a2a/jsonrpc`,
  skills: [
    {
      id: "chat",
      name: "Chat",
      description:
        "Answer conversational prompts and use web search when current information is needed.",
      tags: ["chat", "search"],
      examples: [
        "What is the capital of France?",
        "Search for the latest news on AI",
      ],
      inputModes: ["text/plain", "image/*"],
      outputModes: ["text/plain"],
    },
    {
      id: "image-generation",
      name: "Image Generation",
      description: "Generate an image from a text prompt.",
      tags: ["image", "generation", "creative"],
      examples: [
        "Generate an image of a sunset over mountains",
        "Draw a futuristic city at night",
      ],
      inputModes: ["text/plain"],
      outputModes: ["image/png"],
    },
  ],
  capabilities: {
    streaming: true,
    stateTransitionHistory: true,
  },
  defaultInputModes: ["text/plain", "image/*"],
  defaultOutputModes: ["text/plain", "image/png"],
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
