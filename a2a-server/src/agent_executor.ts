import { v4 as uuidv4 } from 'uuid'; // For generating unique IDs

import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  Artifact,
} from '@a2a-js/sdk';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';
import type { IAgentService } from './agent.ts';

/**
 * SampleAgentExecutor implements the agent's core logic.
 * It uses injected IAgentService for testability.
 */
export class SampleAgentExecutor implements AgentExecutor {
  constructor(private agentService: IAgentService) {}

  public cancelTask = async (_taskId: string, _eventBus: ExecutionEventBus): Promise<void> => {};

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userMessage = requestContext.userMessage;
    const existingTask = requestContext.task;

    // Determine IDs for the task and context
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;

    console.log(
      `[SampleAgentExecutor] Processing message ${userMessage.messageId} for task ${taskId} (context: ${contextId})`
    );

    // 1. Publish initial Task event if it's a new task
    if (!existingTask) {
      const initialTask: Task = {
        kind: 'task',
        id: taskId,
        contextId: contextId,
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString(),
        },
        history: [userMessage], // Start history with the current user message
        metadata: userMessage.metadata, // Carry over metadata from message if any
      };
      eventBus.publish(initialTask);
    }

    // 2. Publish "working" status update
    const workingStatusUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: taskId,
      contextId: contextId,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          role: 'agent',
          messageId: uuidv4(),
          parts: [{ kind: 'text', text: 'Processing your question with LangChain (Ollama qwen3:4b)...' }],
          taskId: taskId,
          contextId: contextId,
        },
        timestamp: new Date().toISOString(),
      },
      final: false,
    };
    eventBus.publish(workingStatusUpdate);

    // 3. Process the entire conversation history through the agent service
    let agentReplyText = '';
    try {
      const rawHistory = existingTask?.history ? [...existingTask.history, userMessage] : [userMessage];
      agentReplyText = await this.agentService.invoke(rawHistory);
    } catch (err: any) {
      console.error(`[SampleAgentExecutor] Error during agent evaluation:`, err);
      agentReplyText = `Sorry, I encountered an error running LangChain: ${err?.message || String(err)}`;
    }

    console.info(`[SampleAgentExecutor] Prompt response: ${agentReplyText}`);

    // Publish artifact with the result
    const artifactId = uuidv4();
    const resultArtifact: Artifact = {
      artifactId: artifactId,
      name: 'Result',
      description: 'The final result from the LangChain agent.',
      parts: [{ kind: 'text', text: agentReplyText }],
    };

    const artifactUpdate: TaskArtifactUpdateEvent = {
      kind: 'artifact-update',
      taskId: taskId,
      contextId: contextId,
      artifact: resultArtifact,
      lastChunk: true,
    };
    eventBus.publish(artifactUpdate);

    // 4. Publish final task status update (completed)
    const finalUpdate: TaskStatusUpdateEvent = {
      kind: 'status-update',
      taskId: taskId,
      contextId: contextId,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
      },
      final: true,
    };
    eventBus.publish(finalUpdate);

    console.log(`[SampleAgentExecutor] Task ${taskId} finished with state: completed`);
  }
}