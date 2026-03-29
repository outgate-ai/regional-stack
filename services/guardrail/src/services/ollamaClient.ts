import fetch from 'node-fetch';
import { LLMClient, OllamaConfig } from '../types';

export class OllamaClient implements LLMClient {
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async query(systemPrompts: string[], userContent?: string): Promise<string> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      ...systemPrompts.map((content) => ({ role: 'system' as const, content })),
    ];

    if (userContent) {
      messages.push({ role: 'user' as const, content: userContent });
    }

    // Use the chat endpoint for Ollama.com API
    const response = await fetch(`${this.config.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GUARDRAIL_LLM_TOKEN}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        stream: false,
        options: {
          num_predict: this.config.maxTokens,
          temperature: this.config.temperature,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}: ${error}`);
    }

    const data = await response.json();

    // Handle both possible response formats
    const content = data.message?.content || data.response || data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`Invalid response from Ollama - no content found, status ${response.status}`);
    }

    if (!content.trim()) {
      throw new Error('Empty response from Ollama');
    }

    return content;
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Simple health check by making a minimal chat request
      const response = await fetch(`${this.config.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GUARDRAIL_LLM_TOKEN}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          options: { num_predict: 1, temperature: 0 },
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
