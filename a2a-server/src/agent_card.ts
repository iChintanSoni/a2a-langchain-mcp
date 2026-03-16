import type { AgentCard } from '@a2a-js/sdk';

export const sampleAgentCard: AgentCard = {
  name: 'Sample Agent',
  description:
    'A sample agent to test the stream functionality and simulate the flow of tasks statuses.',
  url: 'http://localhost:41241/',
  provider: {
    organization: 'A2A Samples',
    url: 'https://example.com/a2a-samples',
  },
  version: '1.0.0',
  protocolVersion: '0.3.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text', 'task-status'],
  skills: [
    {
      id: 'sample_agent',
      name: 'Sample Agent',
      description: 'Simulate the general flow of a streaming agent.',
      tags: ['sample'],
      examples: ['hi', 'hello world', 'how are you', 'goodbye'],
      inputModes: ['text'],
      outputModes: ['text', 'task-status'],
    },
  ],
  supportsAuthenticatedExtendedCard: false,
};
