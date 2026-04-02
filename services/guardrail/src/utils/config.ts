export interface GuardrailConfig {
  port: number;
  logLevel: string;
  maxRequestSize: string;
  healthCheckLLM: boolean;
  logManagerUrl: string;
  redisUrl: string;
  llmHealthTimeoutMs: number;
  llm: {
    provider: 'openai' | 'ollama';
    endpoint: string;
    token?: string;
    model: string;
    timeout: number;
    temperature: number;
    maxTokens: number;
  };
}

export const config: GuardrailConfig = {
  port: parseInt(process.env.GUARDRAIL_PORT || '4002'),
  logLevel: process.env.GUARDRAIL_LOG_LEVEL || 'debug',
  maxRequestSize: process.env.GUARDRAIL_MAX_REQUEST_SIZE || '10mb',
  healthCheckLLM: process.env.GUARDRAIL_HEALTH_CHECK_LLM === 'true',
  logManagerUrl: process.env.LOG_MANAGER_URL || 'http://log-manager:4001',
  redisUrl: process.env.REDIS_URL || '',
  llmHealthTimeoutMs: parseInt(process.env.GUARDRAIL_LLM_HEALTH_TIMEOUT_MS || '3000'),
  llm: {
    provider: (process.env.GUARDRAIL_LLM_PROVIDER as 'openai' | 'ollama') || 'ollama',
    endpoint: process.env.GUARDRAIL_LLM_ENDPOINT || 'https://ollama.com/api',
    token: process.env.GUARDRAIL_LLM_TOKEN,
    model: process.env.GUARDRAIL_LLM_MODEL || 'gpt-oss:20b',
    timeout: parseInt(process.env.GUARDRAIL_LLM_TIMEOUT || '5000'),
    temperature: parseFloat(process.env.GUARDRAIL_LLM_TEMPERATURE || '1'),
    maxTokens: parseInt(process.env.GUARDRAIL_LLM_MAX_TOKENS || '5000'),
  },
};

export function validateConfig(): void {
  if (!config.llm.endpoint) {
    throw new Error('GUARDRAIL_LLM_ENDPOINT is required');
  }

  if (config.llm.provider === 'openai' && !config.llm.token) {
    throw new Error('GUARDRAIL_LLM_TOKEN is required for OpenAI provider');
  }

}
