import { describe, it, expect, vi } from 'vitest';
import { SampleAgentExecutor } from '../src/agent_executor.ts';
import { IAgentService } from '../src/agent.ts';
import { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';


describe('SampleAgentExecutor', () => {
  it('should process a task and publish expected SDK events', async () => {
    // 1. Mock the AgentService
    const mockAgentService: IAgentService = {
      invoke: vi.fn().mockResolvedValue('Mocked response from Agent Service'),
    };

    // 2. Initialize the executor with mocked service
    const executor = new SampleAgentExecutor(mockAgentService);

    // 3. Mock the EventBus
    const publishedEvents: any[] = [];
    const mockEventBus = {
      publish: vi.fn((event) => publishedEvents.push(event)),
    } as unknown as ExecutionEventBus;

    // 4. Create the Request Context
    const requestContext: RequestContext = {
      userMessage: {
        kind: 'message',
        role: 'user',
        messageId: 'msg-123',
        parts: [{ kind: 'text', text: 'Hello, what is a2a?' }],
        taskId: 'task-456',
        contextId: 'ctx-789',
      },
      task: undefined, // Simulating a new task
      taskId: 'task-456',
      contextId: 'ctx-789',
    };

    // 5. Execute
    await executor.execute(requestContext, mockEventBus);

    // 6. Assertions
    expect(mockAgentService.invoke).toHaveBeenCalledTimes(1);

    // Verify correct event publication order
    expect(publishedEvents.length).toBe(4);

    // First event: Task submitted
    expect(publishedEvents[0].kind).toBe('task');
    expect(publishedEvents[0].id).toBe('task-456');
    expect(publishedEvents[0].status.state).toBe('submitted');

    // Second event: Task working
    expect(publishedEvents[1].kind).toBe('status-update');
    expect(publishedEvents[1].status.state).toBe('working');

    // Third event: Artifact with the result
    expect(publishedEvents[2].kind).toBe('artifact-update');
    expect(publishedEvents[2].artifact.parts[0].text).toBe('Mocked response from Agent Service');

    // Fourth event: Task completed
    expect(publishedEvents[3].kind).toBe('status-update');
    expect(publishedEvents[3].status.state).toBe('completed');
  });
});
