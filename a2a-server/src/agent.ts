import { createAgent } from 'langchain';
import { ChatOllama } from '@langchain/ollama';
import { env } from './env.ts';

export interface IAgentService {
  invoke(history: any[]): Promise<string>;
}

export class LangChainAgentService implements IAgentService {
  private agent: ReturnType<typeof createAgent>;

  constructor() {
    const model = new ChatOllama({
      model: env.MODEL,
      temperature: 0.7,
      maxRetries: 2,
    });

    this.agent = createAgent({
      model,
      tools: [], // Add your tools here later if needed
      systemPrompt: 'You are a helpful assistant responding to user queries.',
    });
  }

  async invoke(history: any[]): Promise<string> {
    const langchainMessages = history.map((msg) => {
      // Extract the text content from parts
      const textContent = msg.parts
        .filter((part: any) => part.kind === 'text')
        .map((part: any) => ('text' in part ? part.text : ''))
        .join('\n');

      return {
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: textContent,
      };
    });

    const result = await this.agent.invoke({
      messages: langchainMessages,
    });

    if (typeof result.content === 'string') {
      return result.content;
    } else if (Array.isArray(result.messages) && result.messages.length > 0) {
      return result.messages[result.messages.length - 1].content;
    } else {
      return JSON.stringify(result);
    }
  }
}
