/**
 * Agent card definition for the Chat Agent.
 *
 * The agent card is the A2A protocol's identity document. Keep this shaped like
 * the companion a2a-ui demo server card so the UI discovers the same HTTP
 * transports and capabilities.
 */

import { type AgentCard } from "@a2a-js/sdk";
import { ENV } from "#src/env.ts";

export function createAgentCard(baseUrl: string): AgentCard {
  const jsonRpcUrl = `${baseUrl}/a2a/jsonrpc`;
  const restUrl = `${baseUrl}/a2a/rest`;

  return {
    name: "Chat Agent",
    description: "A conversational A2A agent with search, image input, and image generation.",
    protocolVersion: "0.3.0",
    version: "1.0.0",
    preferredTransport: "JSONRPC",
    url: jsonRpcUrl,
    skills: [
      {
        id: "chat",
        name: "Chat",
        description:
          "Answer conversational prompts and use web search when current information is needed.",
        tags: ["chat", "search"],
        examples: ["What is the capital of France?", "Search for the latest news on AI"],
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
    // Only list interfaces beyond the primary `url` above (no duplicate JSON-RPC)
    additionalInterfaces: [{ url: restUrl, transport: "HTTP+JSON" }],
  };
}

export const agentCard = createAgentCard(`http://${ENV.CARD_HOST}:${ENV.PORT}`);
