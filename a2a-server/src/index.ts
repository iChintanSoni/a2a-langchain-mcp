import type {
  TaskStore,
  AgentExecutor,
} from '@a2a-js/sdk/server';
import {
  InMemoryTaskStore,
  DefaultRequestHandler,
} from '@a2a-js/sdk/server';
import { SampleAgentExecutor } from '#src/agent_executor.ts';
import { sampleAgentCard } from '#src/agent_card.ts';
import { LangChainAgentService } from '#src/agent.ts';
import { createApp } from '#src/app.ts';

import { env } from '#src/env.ts';

// --- Server Setup ---

async function main() {
  // 1. Create TaskStore
  const taskStore: TaskStore = new InMemoryTaskStore();

  // 2. Create Agent Service
  const agentService = new LangChainAgentService();

  // 3. Create AgentExecutor with injected service
  const agentExecutor: AgentExecutor = new SampleAgentExecutor(agentService);

  // 4. Create DefaultRequestHandler
  const requestHandler = new DefaultRequestHandler(sampleAgentCard, taskStore, agentExecutor);

  // 5. Create Express app
  const app = createApp(requestHandler);

  // 6. Start the server
  app.listen(env.PORT, env.HOST, () => {
    console.log(`[SampleAgent] Server using new framework started on http://${env.HOST}:${env.PORT}`);
    console.log(`[SampleAgent] Agent Card: http://${env.HOST}:${env.PORT}/.well-known/agent-card.json`);
    console.log('[SampleAgent] Press Ctrl+C to stop the server');
  });
}

main().catch(console.error);