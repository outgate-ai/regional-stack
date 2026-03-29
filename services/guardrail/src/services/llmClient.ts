import { config } from '../utils/config';
import { LLMClient as ILLMClient } from '../types';
import { OpenAIClient } from './openaiClient';
import { OllamaClient } from './ollamaClient';

export class LLMClient implements ILLMClient {
  private client: ILLMClient;

  constructor() {
    switch (config.llm.provider) {
      case 'openai':
        this.client = new OpenAIClient({
          provider: 'openai',
          model: config.llm.model || 'gpt-4',
          maxTokens: config.llm.maxTokens,
          temperature: config.llm.temperature,
          apiKey: config.llm.token || '',
          baseUrl: config.llm.endpoint,
        });
        break;
      case 'ollama':
        this.client = new OllamaClient({
          provider: 'ollama',
          model: config.llm.model || 'gpt-oss:20b',
          maxTokens: config.llm.maxTokens,
          temperature: config.llm.temperature,
          baseUrl: config.llm.endpoint || 'http://localhost:11434',
        });
        break;
      default:
        throw new Error(`Unsupported LLM provider: ${config.llm.provider}`);
    }
  }

  async query(systemPrompts: string[], userContent?: string): Promise<string> {
    return this.client.query(systemPrompts, userContent);
  }
}
