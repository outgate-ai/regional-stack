export interface ValidationRequest {
  providerId: string;
  method: string;
  path: string;
  body?: string;
  requestBody?: string; // For Kong compatibility
  contentType?: string;
  headers: Record<string, string | string[]>;
  clientIp?: string;
}

export interface ValidationResult {
  decision: 'ALLOW' | 'BLOCK';
  reason: string;
  problematic_content?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  anonymization_map?: Array<[string, string]>; // [original_text, category_hash] pairs
  detections?: Array<{ text: string; category: string; redactMatch?: boolean }>; // Detected sensitive content
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
  blockedAt?: Date;
  userAgent?: string;
  clientIp?: string;
}

export interface LLMResponse {
  content: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface LLMClientConfig {
  endpoint: string;
  token?: string;
  model: string;
  timeout: number;
}

// Smart Router types
export interface SmartRouteUpstream {
  id: string;
  quality: number;
  speed: number;
  cost: number;
}

export interface SmartRouteRequest extends ValidationRequest {
  mode: 'smart_route';
  upstreams: SmartRouteUpstream[];
  organizationId?: string;
  policyId?: string;
}

export interface SmartRouteResult {
  decision: 'ALLOW' | 'BLOCK';
  selectedUpstream?: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  detections?: Array<{ text: string; category: string; redactMatch?: boolean }>;
  anonymization_map?: Array<[string, string]>;
}
