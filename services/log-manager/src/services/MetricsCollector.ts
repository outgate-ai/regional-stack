import Redis from 'ioredis';
import { Logger } from 'pino';

export interface HttpLogData {
  request?: {
    method?: string;
    uri?: string;
    headers?: Record<string, string>;
    body?: any;
    size?: number;
  };
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: any;
    size?: number;
  };
  latencies?: {
    request?: number; // Total request time (ms)
    kong?: number; // Gateway processing time (ms)
    proxy?: number; // Provider response time (ms)
  };
  service?: {
    id?: string;
    name?: string;
  };
  consumer?: {
    id?: string;
    custom_id?: string;
  };
  started_at?: number;
  request_model?: string;
  // Organization ID (set by Kong HTTP log custom_fields_by_lua)
  organization_id?: string;
  // Guardrail fields (set by Kong Lua via kong.log.set_serialize_value)
  guardrail_latency_ms?: number;
  guardrail_validated?: boolean;
  // Token counts (set by Kong Lua body_filter via kong.log.set_serialize_value)
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  // Share tracking (set by Kong Lua when request comes through a shadow provider)
  share_id?: string;
  // Router fields (set by Kong Lua via kong.log.set_serialize_value)
  selected_upstream?: string;
}

interface MetricsData {
  request_count: number;
  total_latency: number;
  gateway_latency: number;
  provider_latency: number;
  request_size: number;
  response_size: number;
  error_count: number;
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
  guardrail_count: number;
  guardrail_latency: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  last_updated: number;
}

interface MetricsDimensions {
  model_id?: string;
  provider_id?: string;
  user_id?: string;
  organization_id?: string;
  share_id?: string;
  selected_upstream?: string;
  time_bucket: string; // 'hour', 'day', 'month'
  timestamp: number; // Bucket timestamp
}

export interface MetricsConfiguration {
  retentionPeriodSeconds: number; // 1 year = 365 * 24 * 3600 = 31,536,000
  aggregationIntervals: {
    hour: number; // 3600 seconds
    day: number; // 86400 seconds
    month: number; // 2592000 seconds (30 days)
  };
  dimensions: string[]; // ['model', 'user', 'org']
}

export class MetricsCollector {
  private redis: Redis;
  private logger: Logger;
  private config: MetricsConfiguration;

  constructor(redis: Redis, logger: Logger, config?: Partial<MetricsConfiguration>) {
    this.redis = redis;
    this.logger = logger;
    this.config = {
      retentionPeriodSeconds: 365 * 24 * 60 * 60, // 1 year
      aggregationIntervals: {
        hour: 60 * 60, // 1 hour
        day: 24 * 60 * 60, // 1 day
        month: 30 * 24 * 60 * 60, // 30 days
      },
      dimensions: ['model', 'user', 'org'],
      ...config,
    };
  }

  /**
   * Extract metrics from HTTP log data
   */
  extractMetrics(httpLogData: HttpLogData): {
    metrics: Partial<MetricsData>;
    dimensions: Partial<MetricsDimensions>;
  } {
    // Extract basic metrics
    const status = httpLogData.response?.status || 0;
    const metrics: Partial<MetricsData> = {
      request_count: 1,
      total_latency: httpLogData.latencies?.request || 0,
      gateway_latency: httpLogData.latencies?.kong || 0,
      provider_latency: httpLogData.latencies?.proxy || 0,
      request_size: httpLogData.request?.size || 0,
      response_size: httpLogData.response?.size || 0,
      error_count: status >= 400 ? 1 : 0,
      status_2xx: status >= 200 && status < 300 ? 1 : 0,
      status_4xx: status >= 400 && status < 500 ? 1 : 0,
      status_5xx: status >= 500 ? 1 : 0,
      guardrail_count: httpLogData.guardrail_validated ? 1 : 0,
      guardrail_latency: httpLogData.guardrail_latency_ms || 0,
      prompt_tokens: httpLogData.prompt_tokens || 0,
      completion_tokens: httpLogData.completion_tokens || 0,
      cache_read_tokens: httpLogData.cache_read_tokens || 0,
      cache_write_tokens: httpLogData.cache_write_tokens || 0,
      last_updated: Date.now(),
    };

    // Extract dimensions
    const providerId = this.extractProviderId(httpLogData);
    const modelId = this.extractModelId(httpLogData);
    const userId = this.extractUserId(httpLogData);
    const organizationId = this.extractOrganizationId(httpLogData);

    const dimensions: Partial<MetricsDimensions> = {
      model_id: modelId,
      provider_id: providerId,
      user_id: userId,
      organization_id: organizationId,
      share_id: httpLogData.share_id || undefined,
      selected_upstream: httpLogData.selected_upstream || undefined,
    };

    return { metrics, dimensions };
  }

  /**
   * Process HTTP log and update aggregated metrics
   */
  async processHttpLog(httpLogData: HttpLogData): Promise<void> {
    try {
      const { metrics, dimensions } = this.extractMetrics(httpLogData);
      const timestamp = httpLogData.started_at || Date.now();

      // SECURITY: Refuse to store metrics without a valid organization ID.
      // Without org isolation, metrics from one org could leak to another.
      if (!dimensions.organization_id) {
        this.logger.warn('Dropping metrics: no organization_id could be determined', {
          service: httpLogData.service?.name,
          consumer: httpLogData.consumer?.custom_id,
        });
        return;
      }

      // Update metrics for different time buckets and dimensions
      const updatePromises: Promise<void>[] = [];

      for (const [bucketType, intervalSeconds] of Object.entries(
        this.config.aggregationIntervals
      )) {
        const bucketTimestamp = this.getBucketTimestamp(timestamp, intervalSeconds);

        // Update model-level metrics
        if (dimensions.model_id && this.config.dimensions?.includes('model')) {
          updatePromises.push(
            this.updateMetrics('model', dimensions.model_id, bucketType, bucketTimestamp, metrics)
          );

          // Store org-model mapping if org dimension is enabled
          if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
            updatePromises.push(
              this.updateMetrics(
                `org:${dimensions.organization_id}:model`,
                dimensions.model_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
          }
        }

        // Update user-level metrics
        if (dimensions.user_id && this.config.dimensions?.includes('user')) {
          updatePromises.push(
            this.updateMetrics('user', dimensions.user_id, bucketType, bucketTimestamp, metrics)
          );

          // Store org-user mapping if org dimension is enabled
          if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
            updatePromises.push(
              this.updateMetrics(
                `org:${dimensions.organization_id}:user`,
                dimensions.user_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
          }
        }

        // Update organization-level metrics
        if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
          updatePromises.push(
            this.updateMetrics(
              'org',
              dimensions.organization_id,
              bucketType,
              bucketTimestamp,
              metrics
            )
          );
        }

        // Update provider-level metrics (additional dimension)
        if (dimensions.provider_id && this.config.dimensions?.includes('provider')) {
          updatePromises.push(
            this.updateMetrics(
              'provider',
              dimensions.provider_id,
              bucketType,
              bucketTimestamp,
              metrics
            )
          );

          // Store org-provider mapping if org dimension is enabled
          if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
            updatePromises.push(
              this.updateMetrics(
                `org:${dimensions.organization_id}:provider`,
                dimensions.provider_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
          }

          // Per-model metrics within a provider (for cost estimation)
          if (dimensions.model_id) {
            updatePromises.push(
              this.updateMetrics(
                `provider:${dimensions.provider_id}:model`,
                dimensions.model_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
            if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
              updatePromises.push(
                this.updateMetrics(
                  `org:${dimensions.organization_id}:provider:${dimensions.provider_id}:model`,
                  dimensions.model_id,
                  bucketType,
                  bucketTimestamp,
                  metrics
                )
              );
            }
          }

          // Per-upstream metrics for routers (when selected_upstream is logged)
          if (dimensions.selected_upstream) {
            updatePromises.push(
              this.updateMetrics(
                `provider:${dimensions.provider_id}:upstream`,
                dimensions.selected_upstream,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
            if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
              updatePromises.push(
                this.updateMetrics(
                  `org:${dimensions.organization_id}:provider:${dimensions.provider_id}:upstream`,
                  dimensions.selected_upstream,
                  bucketType,
                  bucketTimestamp,
                  metrics
                )
              );
            }
          }
        }

        // Per-share metrics (when request comes through a shadow provider)
        if (dimensions.share_id) {
          updatePromises.push(
            this.updateMetrics(
              'share',
              dimensions.share_id,
              bucketType,
              bucketTimestamp,
              metrics
            )
          );
          if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
            updatePromises.push(
              this.updateMetrics(
                `org:${dimensions.organization_id}:share`,
                dimensions.share_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
          }

          // Per-model metrics within a share (for cost estimation)
          if (dimensions.model_id) {
            updatePromises.push(
              this.updateMetrics(
                `share:${dimensions.share_id}:model`,
                dimensions.model_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
            if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
              updatePromises.push(
                this.updateMetrics(
                  `org:${dimensions.organization_id}:share:${dimensions.share_id}:model`,
                  dimensions.model_id,
                  bucketType,
                  bucketTimestamp,
                  metrics
                )
              );
            }
          }
        }

        // Per-model metrics within a user/API key (for cost estimation)
        if (dimensions.user_id && dimensions.model_id && this.config.dimensions?.includes('user')) {
          updatePromises.push(
            this.updateMetrics(
              `user:${dimensions.user_id}:model`,
              dimensions.model_id,
              bucketType,
              bucketTimestamp,
              metrics
            )
          );
          if (dimensions.organization_id && this.config.dimensions?.includes('org')) {
            updatePromises.push(
              this.updateMetrics(
                `org:${dimensions.organization_id}:user:${dimensions.user_id}:model`,
                dimensions.model_id,
                bucketType,
                bucketTimestamp,
                metrics
              )
            );
          }
        }
      }

      await Promise.all(updatePromises);

      this.logger.debug('Metrics updated successfully', {
        dimensions,
        metricsKeys: updatePromises.length,
      });
    } catch (_error) {
      this.logger.error('Failed to process HTTP log for metrics', { error: _error, httpLogData });
      throw _error;
    }
  }

  /**
   * Update metrics in Redis using atomic operations
   */
  private async updateMetrics(
    dimension: string,
    dimensionId: string,
    timeBucket: string,
    bucketTimestamp: number,
    metrics: Partial<MetricsData>
  ): Promise<void> {
    const key = `metrics:${dimension}:${dimensionId}:${timeBucket}:${bucketTimestamp}`;

    // Use Redis pipeline for atomic updates
    const pipeline = this.redis.pipeline();

    // Increment counters
    if (metrics.request_count) {
      pipeline.hincrby(key, 'request_count', metrics.request_count);
    }
    if (metrics.total_latency) {
      pipeline.hincrby(key, 'total_latency', metrics.total_latency);
    }
    if (metrics.gateway_latency) {
      pipeline.hincrby(key, 'gateway_latency', metrics.gateway_latency);
    }
    if (metrics.provider_latency) {
      pipeline.hincrby(key, 'provider_latency', metrics.provider_latency);
    }
    if (metrics.request_size) {
      pipeline.hincrby(key, 'total_requests_size', metrics.request_size);
    }
    if (metrics.response_size) {
      pipeline.hincrby(key, 'total_response_size', metrics.response_size);
    }
    if (metrics.error_count) {
      pipeline.hincrby(key, 'error_count', metrics.error_count);
    }
    if (metrics.status_2xx) {
      pipeline.hincrby(key, 'status_2xx', metrics.status_2xx);
    }
    if (metrics.status_4xx) {
      pipeline.hincrby(key, 'status_4xx', metrics.status_4xx);
    }
    if (metrics.status_5xx) {
      pipeline.hincrby(key, 'status_5xx', metrics.status_5xx);
    }
    if (metrics.guardrail_count) {
      pipeline.hincrby(key, 'guardrail_count', metrics.guardrail_count);
    }
    if (metrics.guardrail_latency) {
      pipeline.hincrby(key, 'guardrail_latency', metrics.guardrail_latency);
    }
    if (metrics.prompt_tokens) {
      pipeline.hincrby(key, 'prompt_tokens', metrics.prompt_tokens);
    }
    if (metrics.completion_tokens) {
      pipeline.hincrby(key, 'completion_tokens', metrics.completion_tokens);
    }
    if (metrics.cache_read_tokens) {
      pipeline.hincrby(key, 'cache_read_tokens', metrics.cache_read_tokens);
    }
    if (metrics.cache_write_tokens) {
      pipeline.hincrby(key, 'cache_write_tokens', metrics.cache_write_tokens);
    }
    if (metrics.last_updated) {
      pipeline.hset(key, 'last_updated', metrics.last_updated);
    }

    // Set TTL for 1 year retention
    pipeline.expire(key, this.config.retentionPeriodSeconds);

    await pipeline.exec();
  }

  /**
   * Get bucket timestamp for time-based aggregation
   */
  private getBucketTimestamp(timestamp: number, intervalSeconds: number): number {
    return Math.floor(timestamp / (intervalSeconds * 1000)) * (intervalSeconds * 1000);
  }

  /**
   * Extract provider ID from HTTP log data
   */
  private extractProviderId(httpLogData: HttpLogData): string | undefined {
    const serviceName = httpLogData.service?.name;
    if (!serviceName) return undefined;

    // Kong service name format: {orgId}-{providerSlug}
    // Extract orgId from available sources, then strip it to get just the provider slug
    const organizationId =
      (httpLogData as any).organization_id ||
      httpLogData.request?.headers?.['x-outgate-org'] ||
      httpLogData.consumer?.custom_id ||
      '';
    const orgPrefix = organizationId ? `${organizationId}-` : '';
    return orgPrefix && serviceName.startsWith(orgPrefix)
      ? serviceName.slice(orgPrefix.length)
      : serviceName;
  }

  /**
   * Extract model ID from HTTP log data (from request path or headers)
   */
  private extractModelId(httpLogData: HttpLogData): string | undefined {
    // Prefer dedicated request_model field (extracted by Kong pre-function)
    if (httpLogData.request_model) {
      return httpLogData.request_model;
    }

    // Try to extract model from request body (for chat completions)
    if (httpLogData.request?.body) {
      try {
        const body =
          typeof httpLogData.request.body === 'string'
            ? JSON.parse(httpLogData.request.body)
            : httpLogData.request.body;

        if (body.model) {
          return body.model;
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Try to extract from headers
    const modelHeader =
      httpLogData.request?.headers?.['x-model-id'] || httpLogData.request?.headers?.['x-model'];
    if (modelHeader) {
      return modelHeader;
    }

    // Try to extract from path for model-specific endpoints
    const path = httpLogData.request?.uri || '';
    const modelMatch = path.match(/\/models\/([^/?]+)/);
    if (modelMatch) {
      return modelMatch[1];
    }

    return undefined;
  }

  /**
   * Extract user ID from consumer data
   */
  private extractUserId(httpLogData: HttpLogData): string | undefined {
    // Prefer custom_id ({orgSlug}-{apiKeyId}) over Kong internal UUID
    // This allows the console to map back to API key names
    return httpLogData.consumer?.custom_id || httpLogData.consumer?.id;
  }

  /**
   * Extract organization ID from consumer or headers
   */
  private extractOrganizationId(httpLogData: HttpLogData): string | undefined {
    // Priority 1: Dedicated organization_id field (set by Kong HTTP log custom_fields_by_lua)
    if (httpLogData.organization_id) {
      return httpLogData.organization_id;
    }

    // Priority 2: Request headers (set by Kong pre-function or request-transformer)
    const orgHeader =
      httpLogData.request?.headers?.['x-organization-id'] ||
      httpLogData.request?.headers?.['x-org-id'] ||
      httpLogData.request?.headers?.['x-outgate-org'];
    if (orgHeader) {
      return orgHeader;
    }

    // Priority 3: Extract org prefix from consumer custom_id
    // Format: {orgSlug}-{apiKeyId} e.g., "o-543aa99257b7ef75-ak-ee03b48eeb4117b2"
    const customId = httpLogData.consumer?.custom_id;
    if (customId && customId.startsWith('o-')) {
      const akIdx = customId.indexOf('-ak-');
      if (akIdx > 0) return customId.slice(0, akIdx);
    }

    return undefined;
  }

  /**
   * Get configuration
   */
  getConfiguration(): MetricsConfiguration {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfiguration(newConfig: Partial<MetricsConfiguration>): void {
    this.config = { ...this.config, ...newConfig };
    this.logger.info('Metrics configuration updated', { config: this.config });
  }
}
