import { Logger } from 'pino';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { ValidationRequest, ValidationResult, SmartRouteUpstream, SmartRouteResult } from '../utils/types';
import { LLMClient } from './llmClient';
import { AlertLogger } from './alertLogger';
import {
  GuardrailConfig,
  defaultGuardrailConfig,
  Detection,
  getHighestSeverity,
  RiskCategory,
  SeverityLevel,
} from '../types/riskConfig';
import { config as appConfig } from '../utils/config';
import { storeDetections, recordScanMetrics, scanForDetections, hashValue } from './fingerprintStore';

export class ValidationService {
  private logger: Logger;
  private llmClient: LLMClient;
  private alertLogger: AlertLogger;
  private systemPrompt: string;
  private categoryPrompts: Map<RiskCategory, string>;
  private config: GuardrailConfig;

  constructor(logger: Logger, config?: GuardrailConfig) {
    this.logger = logger;
    this.llmClient = new LLMClient();
    this.alertLogger = new AlertLogger();
    this.config = config || defaultGuardrailConfig;
    this.systemPrompt = this.loadSystemPrompt();
    this.categoryPrompts = this.loadCategoryPrompts();
    this.logger.info('ValidationService initialized successfully');
  }

  private loadSystemPrompt(): string {
    try {
      const promptPath = join(__dirname, '../prompts/system.txt');
      return readFileSync(promptPath, 'utf-8');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to load system prompt, using default');
      return 'You are a security content analyzer. Return a JSON array of detected risks.';
    }
  }

  private loadCategoryPrompts(): Map<RiskCategory, string> {
    const prompts = new Map<RiskCategory, string>();
    const categories = Object.keys(this.config.riskCategories) as RiskCategory[];

    for (const category of categories) {
      try {
        const promptPath = join(__dirname, `../prompts/${category}.txt`);
        const prompt = readFileSync(promptPath, 'utf-8');
        prompts.set(category, prompt);
      } catch (error) {
        this.logger.warn({ category, error }, `Failed to load prompt for category: ${category}`);
      }
    }

    return prompts;
  }

  private async loadPolicyConfig(policyId: string, organizationId: string): Promise<GuardrailConfig> {
    if (!policyId || policyId === 'default') {
      return this.config;
    }

    try {
      const res = await fetch(`${appConfig.logManagerUrl}/logs/guardrail/policies/${organizationId}/${policyId}`);
      if (res.ok) {
        const data = await res.json() as { riskCategories: Record<string, any> };
        return { riskCategories: data.riskCategories as GuardrailConfig['riskCategories'] };
      }
      this.logger.warn({ policyId, organizationId, status: res.status }, 'Failed to load policy config, using default');
    } catch (error) {
      this.logger.warn({ policyId, organizationId, error: error instanceof Error ? error.message : String(error) }, 'Error loading policy config, using default');
    }
    return this.config;
  }

  private buildConsolidatedSystemPrompt(): string {
    // Consolidate all prompts into a single system message for better LLM comprehension
    const categoryPromptsText = Array.from(this.categoryPrompts.values()).join('\n\n');

    // Replace template placeholder with actual category prompts
    return this.systemPrompt.replace('{{CATEGORY_PROMPTS}}', categoryPromptsText);
  }

  /**
   * Extract only security-relevant text from a request body, stripping images,
   * tool schemas, config params, and thinking blocks. Falls back to the full
   * body if parsing fails or the result is empty.
   */
  private extractTextContent(rawBody: string): string {
    try {
      const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
      if (!body || typeof body !== 'object') return rawBody;

      const parts: string[] = [];

      // --- Detect format and extract system prompt ---

      // OpenAI / Ollama: system messages are in messages array
      // Anthropic: body.system (string or array of text blocks)
      // Responses API: body.instructions
      if (typeof body.system === 'string') {
        parts.push(`[system] ${body.system}`);
      } else if (Array.isArray(body.system)) {
        for (const block of body.system) {
          if (block?.type === 'text' && block.text) parts.push(`[system] ${block.text}`);
        }
      }
      if (typeof body.instructions === 'string') {
        parts.push(`[system] ${body.instructions}`);
      }

      // --- Extract message content ---

      // OpenAI/Anthropic/Ollama: body.messages[]
      const messages = body.messages || [];
      for (const msg of messages) {
        if (!msg) continue;
        const role = msg.role || 'unknown';

        // Simple string content
        if (typeof msg.content === 'string') {
          parts.push(`[${role}] ${msg.content}`);
        }

        // Array content (OpenAI multi-part or Anthropic content blocks)
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!block || typeof block !== 'object') continue;
            // Text blocks
            if (block.type === 'text' && block.text) {
              parts.push(`[${role}] ${block.text}`);
            }
            // Tool results (Anthropic)
            if (block.type === 'tool_result') {
              const resultText = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
                  : '';
              if (resultText) parts.push(`[tool_result] ${resultText}`);
            }
            // Skip: image, image_url, thinking blocks
          }
        }

        // Tool call arguments (may contain user data / secrets)
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const args = tc?.function?.arguments;
            if (args) {
              const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
              parts.push(`[tool_call:${tc.function?.name || 'unknown'}] ${argsStr}`);
            }
          }
        }
      }

      // --- Responses API: body.input (string or array) ---
      if (typeof body.input === 'string') {
        parts.push(`[user] ${body.input}`);
      } else if (Array.isArray(body.input)) {
        for (const item of body.input) {
          if (typeof item === 'string') {
            parts.push(`[user] ${item}`);
          } else if (item?.type === 'message' && Array.isArray(item.content)) {
            for (const block of item.content) {
              if (block?.type === 'input_text' && block.text) {
                parts.push(`[${item.role || 'user'}] ${block.text}`);
              } else if (block?.type === 'output_text' && block.text) {
                parts.push(`[assistant] ${block.text}`);
              }
            }
          }
        }
      }

      // Fallback: if extraction yielded nothing, return full body
      if (parts.length === 0) {
        this.logger.debug('extractTextContent: no text extracted, falling back to full body');
        return rawBody;
      }

      const extracted = parts.join('\n');
      this.logger.debug(
        { originalSize: rawBody.length, extractedSize: extracted.length, ratio: (extracted.length / rawBody.length * 100).toFixed(1) + '%' },
        'extractTextContent: content extracted'
      );
      return extracted;
    } catch (error) {
      // Parse failed — fall back to full body
      this.logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'extractTextContent: parse failed, using full body');
      return rawBody;
    }
  }

  async detectVulnerabilities(request: ValidationRequest): Promise<Detection[]> {
    const rawBody =
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});

    // Extract only security-relevant text (strips images, tools schema, config params)
    const userContent = this.extractTextContent(rawBody);

    // Wrap content in analysis tags to prevent prompt confusion
    const wrappedContent = `<content_to_analyze>\n${userContent}\n</content_to_analyze>`;

    // Build single consolidated system message with all prompts and instructions
    const consolidatedSystemPrompt = this.buildConsolidatedSystemPrompt();

    // Send system prompt as system message, wrapped content as user message
    return this.parseAllDetections(await this.llmClient.query([consolidatedSystemPrompt], wrappedContent));
  }

  async validateRequest(request: ValidationRequest, policyId?: string, organizationId?: string): Promise<ValidationResult> {
    try {
      this.logger.debug({ providerId: request.providerId }, 'Starting validation');

      // --- KV fingerprint scan (before LLM) ---
      const orgId = (request.headers?.['x-organization-id'] as string) || organizationId || '';
      const rawBody = (request as any).body || '';
      let kvMatches: Awaited<ReturnType<typeof scanForDetections>> = [];
      if (orgId && rawBody) {
        try {
          kvMatches = await scanForDetections(orgId, typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
          if (kvMatches.length > 0) {
            this.logger.info({ orgId, kvHits: kvMatches.length }, 'KV fingerprint matches found');
          }
        } catch (err) {
          this.logger.warn({ error: (err as Error).message }, 'KV scan failed, falling through to LLM');
        }
      }

      const allDetections = await this.detectVulnerabilities(request);

      // Load dynamic policy config if a custom policyId is provided
      const policyConfig = policyId ? await this.loadPolicyConfig(policyId, organizationId || '') : this.config;

      this.logger.debug(
        { providerId: request.providerId, detectionsCount: allDetections.length },
        'Validation completed'
      );

      const result = this.aggregateDetections(allDetections, policyConfig);

      if (result.decision === 'BLOCK') {
        this.logger.warn(
          {
            providerId: request.providerId,
            path: request.path,
            method: request.method,
            reason: result.reason,
            severity: result.severity,
          },
          'Request blocked'
        );

        // Log the blocked request as an alert
        try {
          const alertRequest = {
            method: request.method,
            path: request.path,
            body: request.body,
            headers: request.headers as Record<string, string>,
            organizationId: (request.headers['x-organization-id'] as string) || 'unknown',
            providerId: request.providerId,
            clientIp: request.clientIp,
            userAgent: request.headers['user-agent'] as string,
            requestId: new Date().getTime().toString(),
          };
          await this.alertLogger.logBlockedRequest(alertRequest, result);
        } catch (alertError) {
          this.logger.error(
            {
              error: alertError instanceof Error ? alertError.message : String(alertError),
              providerId: request.providerId,
            },
            'Failed to log blocked request alert'
          );
        }
      } else if (result.decision === 'ALLOW' && allDetections.length > 0) {
        // Log non-blocking detections with low severity
        this.logger.info(
          {
            providerId: request.providerId,
            path: request.path,
            method: request.method,
            detectionsCount: allDetections.length,
            reason: result.reason,
          },
          'Non-blocking detection'
        );

        try {
          const alertRequest = {
            method: request.method,
            path: request.path,
            body: request.body,
            headers: request.headers as Record<string, string>,
            organizationId: (request.headers['x-organization-id'] as string) || 'unknown',
            providerId: request.providerId,
            clientIp: request.clientIp,
            userAgent: request.headers['user-agent'] as string,
            requestId: new Date().getTime().toString(),
          };
          await this.alertLogger.logNonBlockingDetection(alertRequest, result);
        } catch (alertError) {
          this.logger.error(
            {
              error: alertError instanceof Error ? alertError.message : String(alertError),
              providerId: request.providerId,
            },
            'Failed to log non-blocking detection'
          );
        }
      }

      // Merge KV matches into the anonymization map (if not already covered by LLM)
      if (kvMatches.length > 0) {
        const existingAnon = new Set((result.anonymization_map || []).map(([orig]) => orig));
        const kvAnon: Array<[string, string]> = [];
        for (const m of kvMatches) {
          if (!existingAnon.has(m.originalText)) {
            kvAnon.push([m.originalText, `<${m.hash.slice(0, 12)}>`]);
          }
        }
        if (kvAnon.length > 0) {
          result.anonymization_map = [...(result.anonymization_map || []), ...kvAnon];
          this.logger.info({ orgId, kvAnonymized: kvAnon.length }, 'KV matches added to anonymization map');
        }
      }

      // Store NEW detections in fingerprint KV store (fire-and-forget)
      // Only store LLM detections that KV didn't already know about
      if (allDetections.length > 0 && orgId) {
        const kvHashes = new Set(kvMatches.map(m => m.hash));
        const newDetections = allDetections.filter(d => !kvHashes.has(hashValue(d.text)));

        if (newDetections.length > 0) {
          storeDetections(orgId, newDetections, result.anonymization_map)
            .then((count) => {
              if (count > 0) this.logger.debug({ orgId, stored: count }, 'New fingerprints stored');
            })
            .catch((err) => {
              this.logger.warn({ error: err.message }, 'Failed to store fingerprints');
            });
        }
        recordScanMetrics(orgId, kvMatches.length, newDetections.length).catch(() => {});
      } else if (kvMatches.length > 0 && orgId) {
        // All matches were from KV, no new LLM detections
        recordScanMetrics(orgId, kvMatches.length, 0).catch(() => {});
      }

      // Attach KV match info to result for dry-run responses
      (result as any).kvMatches = kvMatches.length;
      (result as any).fingerprintsStored = allDetections.length - kvMatches.length;

      return result;
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          providerId: request.providerId,
        },
        'Validation error, failing open'
      );
      // Fail-open: allow request if validation fails
      return {
        decision: 'ALLOW',
        reason: 'Validation service error - failing open',
        severity: 'medium',
        confidence: 0.5,
      };
    }
  }

  private loadSmartRouteCombinedPrompt(): string {
    try {
      const promptPath = join(__dirname, '../prompts/smart_route_combined.txt');
      return readFileSync(promptPath, 'utf-8');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to load smart route combined prompt, using default');
      return 'Analyze content for security risks and select the best upstream. Return: {"detections": [], "selectedUpstream": "<id>"}';
    }
  }

  /**
   * Parse the combined smart route LLM response: { detections: [...], selectedUpstream: "..." }
   * Handles edge cases: refusal, plain array (no routing), missing fields.
   */
  private parseSmartRouteResponse(
    response: string,
    upstreams: SmartRouteUpstream[],
  ): { detections: Detection[]; selectedUpstream: string } {
    const fallbackUpstream = upstreams[0].id;

    try {
      let cleaned = response.trim();
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      if (!cleaned) {
        return { detections: [], selectedUpstream: fallbackUpstream };
      }

      const parsed = JSON.parse(cleaned.trim());

      // Refusal handling
      if (parsed && typeof parsed === 'object' && parsed.refused === true) {
        this.logger.warn('Smart route: LLM refused to analyze content');
        return {
          detections: [{ text: 'Content refused by LLM safety filters', category: 'malicious_content' }],
          selectedUpstream: fallbackUpstream,
        };
      }

      // Edge case: LLM returned a plain array (ignored routing instruction)
      if (Array.isArray(parsed)) {
        this.logger.warn('Smart route: LLM returned plain array, treating as detections only');
        const detections = this.extractDetections(parsed);
        return { detections, selectedUpstream: fallbackUpstream };
      }

      // Expected format: { detections: [...], selectedUpstream: "..." }
      const detections = Array.isArray(parsed.detections)
        ? this.extractDetections(parsed.detections)
        : [];

      let selectedUpstream = fallbackUpstream;
      if (parsed.selectedUpstream && upstreams.some(u => u.id === parsed.selectedUpstream)) {
        selectedUpstream = parsed.selectedUpstream;
      } else if (parsed.selectedUpstream) {
        this.logger.warn({ response: parsed.selectedUpstream }, 'Smart route: LLM returned invalid upstream, using first');
      }

      return { detections, selectedUpstream };
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Smart route: failed to parse combined LLM response'
      );
      return { detections: [], selectedUpstream: fallbackUpstream };
    }
  }

  /** Filter and normalize a raw detections array from LLM output. */
  private extractDetections(items: any[]): Detection[] {
    return items
      .filter((item: any) =>
        item && typeof item === 'object' &&
        typeof item.text === 'string' && item.text.trim() !== '' &&
        typeof item.category === 'string'
      )
      .map((item: any) => ({
        text: item.text.trim(),
        category: this.normalizeCategory(item.category),
      }));
  }

  async smartRoute(
    request: ValidationRequest,
    upstreams: SmartRouteUpstream[],
    policyId?: string,
    organizationId?: string,
  ): Promise<SmartRouteResult> {
    try {
      this.logger.debug({ providerId: request.providerId }, 'Starting smart route');

      // 1. Build combined prompt (detection + routing in one call)
      const categoryPromptsText = Array.from(this.categoryPrompts.values()).join('\n\n');
      const upstreamList = upstreams.map((u, i) =>
        `${i + 1}. ${u.id}: Quality=${u.quality}/10, Speed=${u.speed}/10, Cost=${u.cost}/10`
      ).join('\n');

      let combinedPrompt = this.loadSmartRouteCombinedPrompt();
      combinedPrompt = combinedPrompt
        .replace('{{CATEGORY_PROMPTS}}', categoryPromptsText)
        .replace('{{UPSTREAM_LIST}}', upstreamList);

      // 2. Extract text content and wrap (same as detectVulnerabilities)
      const rawBody = typeof request.body === 'string'
        ? request.body : JSON.stringify(request.body || {});
      const userContent = this.extractTextContent(rawBody);
      const wrappedContent = `<content_to_analyze>\n${userContent}\n</content_to_analyze>`;

      // 3. Single LLM call — detection + routing combined
      const llmResponse = await this.llmClient.query([combinedPrompt], wrappedContent);

      // 4. Parse combined response
      const { detections: allDetections, selectedUpstream } = this.parseSmartRouteResponse(llmResponse, upstreams);

      // 5. Aggregate detections and apply policy
      const policyConfig = policyId ? await this.loadPolicyConfig(policyId, organizationId || '') : this.config;
      const validationResult = this.aggregateDetections(allDetections, policyConfig);

      // 6. If BLOCK → return immediately without routing
      if (validationResult.decision === 'BLOCK') {
        this.logger.warn({ providerId: request.providerId }, 'Smart route: request blocked by guardrail');
        return {
          decision: 'BLOCK',
          reason: validationResult.reason,
          severity: validationResult.severity,
          confidence: validationResult.confidence,
          detections: validationResult.detections,
        };
      }

      this.logger.info(
        { providerId: request.providerId, selectedUpstream, detectionsCount: allDetections.length },
        'Smart route completed'
      );

      return {
        decision: 'ALLOW',
        selectedUpstream,
        reason: `Routed to ${selectedUpstream} based on content analysis`,
        severity: validationResult.severity,
        confidence: 0.9,
        detections: validationResult.detections,
        anonymization_map: validationResult.anonymization_map,
      };
    } catch (error) {
      this.logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          providerId: request.providerId,
        },
        'Smart route error'
      );
      // Fail closed for smart router — no fallback
      throw error;
    }
  }

  private static readonly VALID_CATEGORIES: Set<string> = new Set([
    'personal_information',
    'credentials',
    'prompt_injection',
    'malicious_content',
    'sensitive_data',
  ]);

  // Map common LLM category hallucinations to valid categories
  private static readonly CATEGORY_ALIASES: Record<string, RiskCategory> = {
    api_key: 'credentials',
    api_keys: 'credentials',
    secret: 'credentials',
    secrets: 'credentials',
    password: 'credentials',
    passwords: 'credentials',
    token: 'credentials',
    tokens: 'credentials',
    key: 'credentials',
    keys: 'credentials',
    auth: 'credentials',
    authentication: 'credentials',
    credential: 'credentials',
    pii: 'personal_information',
    personal_data: 'personal_information',
    personal_info: 'personal_information',
    private_information: 'personal_information',
    injection: 'prompt_injection',
    jailbreak: 'prompt_injection',
    malicious: 'malicious_content',
    harmful_content: 'malicious_content',
    sensitive: 'sensitive_data',
    confidential: 'sensitive_data',
    confidential_data: 'sensitive_data',
  };

  private normalizeCategory(rawCategory: string): RiskCategory {
    const lower = rawCategory.toLowerCase().trim();
    if (ValidationService.VALID_CATEGORIES.has(lower)) {
      return lower as RiskCategory;
    }
    const alias = ValidationService.CATEGORY_ALIASES[lower];
    if (alias) {
      this.logger.debug({ rawCategory, normalized: alias }, 'Normalized LLM category via alias');
      return alias;
    }
    // Fallback: try substring matching
    if (lower.includes('credential') || lower.includes('key') || lower.includes('secret') || lower.includes('password') || lower.includes('token')) {
      this.logger.debug({ rawCategory, normalized: 'credentials' }, 'Normalized LLM category via substring match');
      return 'credentials';
    }
    if (lower.includes('personal') || lower.includes('pii')) {
      return 'personal_information';
    }
    if (lower.includes('injection') || lower.includes('jailbreak')) {
      return 'prompt_injection';
    }
    if (lower.includes('malicious') || lower.includes('harmful')) {
      return 'malicious_content';
    }
    // Default unknown categories to sensitive_data
    this.logger.warn({ rawCategory }, 'Unknown LLM category, defaulting to sensitive_data');
    return 'sensitive_data';
  }

  private parseAllDetections(response: string): Detection[] {
    try {
      let cleanedResponse = response.trim();

      if (cleanedResponse.startsWith('```json')) {
        cleanedResponse = cleanedResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanedResponse.startsWith('```')) {
        cleanedResponse = cleanedResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      if (!cleanedResponse) {
        return [];
      }

      const parsed = JSON.parse(cleanedResponse.trim());

      // Check for refusal response
      if (parsed && typeof parsed === 'object' && parsed.refused === true) {
        this.logger.warn('LLM refused to analyze content - treating as blocking detection');
        return [{ text: 'Content refused by LLM safety filters', category: 'malicious_content' }];
      }

      if (!Array.isArray(parsed)) {
        this.logger.warn('LLM response is not an array, returning empty detections');
        return [];
      }

      return this.extractDetections(parsed);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to parse LLM response, returning empty detections'
      );
      return [];
    }
  }

  aggregateDetections(detections: Detection[], policyConfig?: GuardrailConfig): ValidationResult {
    if (detections.length === 0) {
      return {
        decision: 'ALLOW',
        reason: 'No security risks detected',
        severity: 'low',
        confidence: 1.0,
      };
    }

    // Group detections by category
    const detectionsByCategory = detections.reduce(
      (acc, detection) => {
        if (!acc[detection.category]) {
          acc[detection.category] = [];
        }
        acc[detection.category].push(detection);
        return acc;
      },
      {} as Record<RiskCategory, Detection[]>
    );

    // Determine blocking categories, severities, and anonymization mappings
    const blockingCategories: RiskCategory[] = [];
    const severities: SeverityLevel[] = [];
    const reasons: string[] = [];
    const anonymizationMap: Array<[string, string]> = [];

    const effectiveConfig = policyConfig || this.config;
    for (const [category, categoryDetections] of Object.entries(detectionsByCategory)) {
      const categoryConfig = effectiveConfig.riskCategories[category as RiskCategory];

      if (categoryConfig) {
        severities.push(categoryConfig.severity);

        // Build anonymization map if anonymization is enabled for this category
        if (categoryConfig.anonymization) {
          for (const detection of categoryDetections) {
            const hash = createHash('md5').update(detection.text).digest('hex');
            const anonymizedToken = `${category}_${hash}`;
            anonymizationMap.push([detection.text, anonymizedToken]);
          }
        }

        if (categoryConfig.blocking) {
          blockingCategories.push(category as RiskCategory);
          const shouldRedact = categoryConfig.redactMatch !== false;
          const detectionTexts = categoryDetections
            .map((d) => {
              if (shouldRedact) {
                const preview = d.text.substring(0, Math.min(4, d.text.length));
                return `"${preview}...[REDACTED]"`;
              }
              return `"${d.text}"`;
            })
            .join(', ');
          reasons.push(`${category.replace(/_/g, ' ')}: ${detectionTexts}`);
        }
      }
    }

    const highestSeverity = getHighestSeverity(severities);
    const shouldBlock = blockingCategories.length > 0;

    // Redact problematic_content based on per-category redactMatch setting
    const redactedProblematicContent = detections
      .map((d) => {
        const catCfg = effectiveConfig.riskCategories[d.category as RiskCategory];
        const shouldRedact = !catCfg || catCfg.redactMatch !== false;
        if (shouldRedact) {
          const preview = d.text.substring(0, Math.min(4, d.text.length));
          return `${preview}...[REDACTED]`;
        }
        return d.text;
      })
      .join(', ');

    const result: ValidationResult = {
      decision: shouldBlock ? 'BLOCK' : 'ALLOW',
      reason: shouldBlock
        ? `Detected ${blockingCategories.length} blocking risk(s): ${reasons.join('; ')}`
        : `Detected ${detections.length} risk(s) but none are blocking`,
      severity: highestSeverity as 'low' | 'medium' | 'high' | 'critical',
      confidence: 0.9,
      problematic_content: redactedProblematicContent,
      detections: detections.map((d) => {
        const catCfg = effectiveConfig.riskCategories[d.category as RiskCategory];
        return {
          text: d.text,
          category: d.category,
          redactMatch: !catCfg || catCfg.redactMatch !== false,
        };
      }),
    };

    // Only include anonymization_map if there are items
    if (anonymizationMap.length > 0) {
      result.anonymization_map = anonymizationMap;
    }

    return result;
  }
}
