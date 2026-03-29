export interface ValidationRequest {
  method: string;
  path: string;
  body?: any;
  headers: Record<string, string>;
  organizationId: string;
  providerId: string;
  clientIp?: string;
  userAgent?: string;
  requestId?: string;
}

export interface ValidationResult {
  decision: 'ALLOW' | 'BLOCK';
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  problematicContent?: string;
  detections?: Array<{ text: string; category: string; redactMatch?: boolean }>; // Detected sensitive content
  anonymization_map?: Array<[string, string]>; // [original_text, anonymized_token] pairs
}

export interface LLMClient {
  query(_systemPrompts: string[], _userContent?: string): Promise<string>;
}

export interface AlertLogger {
  logBlockedRequest(_request: ValidationRequest, _result: ValidationResult): Promise<void>;
  close(): Promise<void>;
}

export interface LLMConfig {
  provider: 'openai' | 'ollama';
  model: string;
  maxTokens: number;
  temperature: number;
}

export interface OpenAIConfig extends LLMConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface OllamaConfig extends LLMConfig {
  baseUrl: string;
}

export interface AlertData {
  id?: string;
  providerId: string;
  organizationId: string;
  requestId?: string;
  method: string;
  path: string;
  requestBody?: string;
  reason: string;
  problematicContent?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  clientIp?: string;
  userAgent?: string;
  blockedAt?: Date;
}
