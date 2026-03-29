import fetch from 'node-fetch';
import { LLMClient, OpenAIConfig } from '../types';

export class OpenAIClient implements LLMClient {
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = config;
  }

  async query(systemPrompts: string[], userContent?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      ...systemPrompts.map((content) => ({ role: 'system' as const, content })),
    ];

    if (userContent) {
      messages.push({ role: 'user' as const, content: userContent });
    }

    // GPT-5 models require max_completion_tokens instead of max_tokens
    const isGPT5Model = this.config.model.startsWith('gpt-5');
    const requestBody: any = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
    };

    if (isGPT5Model) {
      requestBody.max_completion_tokens = this.config.maxTokens;
    } else {
      requestBody.max_tokens = this.config.maxTokens;
    }

    const url = this.config.baseUrl
      ? `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}: ${error}`);
    }

    const data = await response.json();

    if (!data.choices || data.choices.length === 0) {
      throw new Error('No response from OpenAI');
    }

    const content = data.choices[0].message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    return content;
  }
}
