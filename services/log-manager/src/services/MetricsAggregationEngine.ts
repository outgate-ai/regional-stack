import Redis from 'ioredis';
import { Logger } from 'pino';
import { MetricsConfiguration } from './MetricsCollector';

interface TimeSeriesPoint {
  timestamp: number;
  request_count: number;
  avg_latency: number;
  avg_gateway_latency: number;
  avg_provider_latency: number;
  error_rate: number;
  total_request_size: number;
  total_response_size: number;
  status_2xx: number;
  status_4xx: number;
  status_5xx: number;
  guardrail_count: number;
  avg_guardrail_latency: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface MetricsSummary {
  total_requests: number;
  avg_latency: number;
  error_rate: number;
  total_request_size: number;
  total_response_size: number;
  avg_gateway_latency: number;
  avg_provider_latency: number;
  total_2xx: number;
  total_4xx: number;
  total_5xx: number;
  total_guardrail_evaluations: number;
  avg_guardrail_latency: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
}

export interface MetricsQueryOptions {
  timespan: '1h' | '24h' | '7d' | '30d' | '90d' | '1y';
  granularity: 'hour' | 'day' | 'week' | 'month';
  startTime?: number;
  endTime?: number;
}

interface TopItem {
  id: string;
  name?: string;
  request_count: number;
  avg_latency?: number;
  error_rate?: number;
  status_2xx?: number;
  status_4xx?: number;
  status_5xx?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

interface DashboardData {
  timespan: string;
  summary: MetricsSummary & {
    active_models: number;
    active_users: number;
    active_providers: number;
  };
  top_models: TopItem[];
  top_users: TopItem[];
  top_providers: TopItem[];
  latency_trend: TimeSeriesPoint[];
  error_rate_trend: TimeSeriesPoint[];
  request_volume_trend: TimeSeriesPoint[];
}

export class MetricsAggregationEngine {
  private redis: Redis;
  private logger: Logger;
  private config: MetricsConfiguration;

  constructor(redis: Redis, logger: Logger, config: MetricsConfiguration) {
    this.redis = redis;
    this.logger = logger;
    this.config = config;
  }

  /**
   * Get metrics for a specific model
   */
  async getModelMetrics(
    modelId: string,
    options: MetricsQueryOptions
  ): Promise<{
    model_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const { timespan, granularity } = options;
    const { startTime, endTime } = this.getTimeRange(timespan);
    const bucketInterval = this.getBucketInterval(granularity);

    const data: TimeSeriesPoint[] = [];
    const summaryData = {
      total_requests: 0,
      total_latency: 0,
      total_errors: 0,
      total_request_size: 0,
      total_response_size: 0,
      total_gateway_latency: 0,
      total_provider_latency: 0,
      total_2xx: 0,
      total_4xx: 0,
      total_5xx: 0,
      total_guardrail_count: 0,
      total_guardrail_latency: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
    };

    // Get all bucket timestamps for the time range
    const buckets = this.getBucketTimestamps(startTime, endTime, bucketInterval);

    for (const bucketTimestamp of buckets) {
      const key = `metrics:model:${modelId}:${granularity}:${bucketTimestamp}`;
      const metrics = await this.redis.hgetall(key);

      if (!metrics || Object.keys(metrics).length === 0) {
        // No data for this bucket, add zero point
        data.push({
          timestamp: bucketTimestamp,
          request_count: 0,
          avg_latency: 0,
          avg_gateway_latency: 0,
          avg_provider_latency: 0,
          error_rate: 0,
          total_request_size: 0,
          total_response_size: 0,
          status_2xx: 0,
          status_4xx: 0,
          status_5xx: 0,
          guardrail_count: 0,
          avg_guardrail_latency: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        });
        continue;
      }

      const requestCount = parseInt(metrics.request_count || '0');
      const totalLatency = parseInt(metrics.total_latency || '0');
      const gatewayLatency = parseInt(metrics.gateway_latency || '0');
      const providerLatency = parseInt(metrics.provider_latency || '0');
      const errorCount = parseInt(metrics.error_count || '0');
      const requestSize = parseInt(metrics.total_requests_size || '0');
      const responseSize = parseInt(metrics.total_response_size || '0');
      const s2xx = parseInt(metrics.status_2xx || '0');
      const s4xx = parseInt(metrics.status_4xx || '0');
      const s5xx = parseInt(metrics.status_5xx || '0');
      const grCount = parseInt(metrics.guardrail_count || '0');
      const grLatency = parseInt(metrics.guardrail_latency || '0');
      const pTokens = parseInt(metrics.prompt_tokens || '0');
      const cTokens = parseInt(metrics.completion_tokens || '0');
      const crTokens = parseInt(metrics.cache_read_tokens || '0');
      const cwTokens = parseInt(metrics.cache_write_tokens || '0');

      const avgLatency = requestCount > 0 ? Math.round(totalLatency / requestCount) : 0;
      const avgGatewayLatency = requestCount > 0 ? Math.round(gatewayLatency / requestCount) : 0;
      const avgProviderLatency = requestCount > 0 ? Math.round(providerLatency / requestCount) : 0;
      const errorRate = requestCount > 0 ? Number((errorCount / requestCount).toFixed(3)) : 0;

      data.push({
        timestamp: bucketTimestamp,
        request_count: requestCount,
        avg_latency: avgLatency,
        avg_gateway_latency: avgGatewayLatency,
        avg_provider_latency: avgProviderLatency,
        error_rate: errorRate,
        total_request_size: requestSize,
        total_response_size: responseSize,
        status_2xx: s2xx,
        status_4xx: s4xx,
        status_5xx: s5xx,
        guardrail_count: grCount,
        avg_guardrail_latency: grCount > 0 ? Math.round(grLatency / grCount) : 0,
        prompt_tokens: pTokens,
        completion_tokens: cTokens,
        cache_read_tokens: crTokens,
        cache_write_tokens: cwTokens,
      });

      // Accumulate for summary
      summaryData.total_requests += requestCount;
      summaryData.total_latency += totalLatency;
      summaryData.total_errors += errorCount;
      summaryData.total_request_size += requestSize;
      summaryData.total_response_size += responseSize;
      summaryData.total_gateway_latency += gatewayLatency;
      summaryData.total_provider_latency += providerLatency;
      summaryData.total_2xx += s2xx;
      summaryData.total_4xx += s4xx;
      summaryData.total_5xx += s5xx;
      summaryData.total_guardrail_count += grCount;
      summaryData.total_guardrail_latency += grLatency;
      summaryData.total_prompt_tokens += pTokens;
      summaryData.total_completion_tokens += cTokens;
      summaryData.total_cache_read_tokens += crTokens;
      summaryData.total_cache_write_tokens += cwTokens;
    }

    // Calculate summary statistics
    const summary: MetricsSummary = {
      total_requests: summaryData.total_requests,
      avg_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_latency / summaryData.total_requests)
          : 0,
      avg_gateway_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_gateway_latency / summaryData.total_requests)
          : 0,
      avg_provider_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_provider_latency / summaryData.total_requests)
          : 0,
      error_rate:
        summaryData.total_requests > 0
          ? Number((summaryData.total_errors / summaryData.total_requests).toFixed(3))
          : 0,
      total_request_size: summaryData.total_request_size,
      total_response_size: summaryData.total_response_size,
      total_2xx: summaryData.total_2xx,
      total_4xx: summaryData.total_4xx,
      total_5xx: summaryData.total_5xx,
      total_guardrail_evaluations: summaryData.total_guardrail_count,
      avg_guardrail_latency:
        summaryData.total_guardrail_count > 0
          ? Math.round(summaryData.total_guardrail_latency / summaryData.total_guardrail_count)
          : 0,
      total_prompt_tokens: summaryData.total_prompt_tokens,
      total_completion_tokens: summaryData.total_completion_tokens,
      total_cache_read_tokens: summaryData.total_cache_read_tokens,
      total_cache_write_tokens: summaryData.total_cache_write_tokens,
    };

    return {
      model_id: modelId,
      timespan,
      granularity,
      data,
      summary,
    };
  }

  /**
   * Get metrics for a specific user
   */
  async getUserMetrics(
    userId: string,
    options: MetricsQueryOptions
  ): Promise<{
    user_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics('user', userId, options);
    return {
      user_id: userId,
      ...result,
    };
  }

  /**
   * Get metrics for a specific organization
   */
  async getOrganizationMetrics(
    organizationId: string,
    options: MetricsQueryOptions
  ): Promise<{
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics('org', organizationId, options);
    return {
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get metrics for a specific model within an organization
   */
  async getOrganizationModelMetrics(
    organizationId: string,
    modelId: string,
    options: MetricsQueryOptions
  ): Promise<{
    model_id: string;
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    // Use the organization-specific model metrics key
    const result = await this.getDimensionMetrics(`org:${organizationId}:model`, modelId, options);
    return {
      model_id: modelId,
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get metrics for a specific user within an organization
   */
  async getOrganizationUserMetrics(
    organizationId: string,
    userId: string,
    options: MetricsQueryOptions
  ): Promise<{
    user_id: string;
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics(`org:${organizationId}:user`, userId, options);
    return {
      user_id: userId,
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get metrics for a specific provider within an organization
   */
  async getOrganizationProviderMetrics(
    organizationId: string,
    providerId: string,
    options: MetricsQueryOptions
  ): Promise<{
    provider_id: string;
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics(`org:${organizationId}:provider`, providerId, options);
    return {
      provider_id: providerId,
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get metrics for a specific upstream within a provider (router)
   */
  async getProviderUpstreamMetrics(
    organizationId: string,
    providerId: string,
    upstreamId: string,
    options: MetricsQueryOptions
  ): Promise<{
    provider_id: string;
    upstream_id: string;
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics(
      `org:${organizationId}:provider:${providerId}:upstream`,
      upstreamId,
      options
    );
    return {
      provider_id: providerId,
      upstream_id: upstreamId,
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get top upstreams for a provider (router) with their metrics
   */
  async getProviderUpstreams(
    organizationId: string,
    providerId: string,
    options: MetricsQueryOptions,
    limit: number = 20
  ): Promise<TopItem[]> {
    return this.getTopItems(
      `provider:${providerId}:upstream`,
      options,
      limit,
      organizationId
    );
  }

  /**
   * Get per-model token breakdown for a provider (for cost estimation)
   */
  async getProviderModelBreakdown(
    organizationId: string,
    providerId: string,
    options: MetricsQueryOptions,
    limit: number = 50
  ): Promise<TopItem[]> {
    return this.getTopItems(
      `provider:${providerId}:model`,
      options,
      limit,
      organizationId
    );
  }

  /**
   * Get per-model token breakdown for a share (for cost estimation)
   */
  async getShareModelBreakdown(
    organizationId: string,
    shareId: string,
    options: MetricsQueryOptions,
    limit: number = 50
  ): Promise<TopItem[]> {
    return this.getTopItems(
      `share:${shareId}:model`,
      options,
      limit,
      organizationId
    );
  }

  /**
   * Get per-model token breakdown for a user/API key (for cost estimation)
   */
  async getUserModelBreakdown(
    organizationId: string,
    userId: string,
    options: MetricsQueryOptions,
    limit: number = 50
  ): Promise<TopItem[]> {
    return this.getTopItems(
      `user:${userId}:model`,
      options,
      limit,
      organizationId
    );
  }

  /**
   * Get top shares with their metrics
   */
  async getTopShares(
    organizationId: string,
    options: MetricsQueryOptions,
    limit: number = 20
  ): Promise<TopItem[]> {
    return this.getTopItems(
      'share',
      options,
      limit,
      organizationId
    );
  }

  /**
   * Get metrics for a specific share
   */
  async getShareMetrics(
    organizationId: string,
    shareId: string,
    options: MetricsQueryOptions
  ): Promise<{
    share_id: string;
    organization_id: string;
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const result = await this.getDimensionMetrics(`org:${organizationId}:share`, shareId, options);
    return {
      share_id: shareId,
      organization_id: organizationId,
      ...result,
    };
  }

  /**
   * Get dashboard summary data
   */
  async getDashboardData(
    options: MetricsQueryOptions,
    organizationId?: string
  ): Promise<DashboardData> {
    const { timespan } = options;

    // Get overall summary by aggregating across all dimensions for the organization
    const summary = await this.getOverallSummary(options, organizationId);

    // Get top items for different dimensions filtered by organization
    const [topModels, topUsers, topProviders] = await Promise.all([
      this.getTopItems('model', options, 10, organizationId),
      this.getTopItems('user', options, 10, organizationId),
      this.getTopItems('provider', options, 10, organizationId),
    ]);

    // Get trend data filtered by organization
    const [latencyTrend, errorRateTrend, requestVolumeTrend] = await Promise.all([
      this.getLatencyTrend(options, organizationId),
      this.getErrorRateTrend(options, organizationId),
      this.getRequestVolumeTrend(options, organizationId),
    ]);

    return {
      timespan,
      summary: {
        ...summary,
        active_models: topModels.filter((m) => m.request_count > 0).length,
        active_users: topUsers.filter((u) => u.request_count > 0).length,
        active_providers: topProviders.filter((p) => p.request_count > 0).length,
      },
      top_models: topModels,
      top_users: topUsers,
      top_providers: topProviders,
      latency_trend: latencyTrend,
      error_rate_trend: errorRateTrend,
      request_volume_trend: requestVolumeTrend,
    };
  }

  /**
   * Generic method to get metrics for any dimension
   */
  private async getDimensionMetrics(
    dimension: string,
    dimensionId: string,
    options: MetricsQueryOptions
  ): Promise<{
    timespan: string;
    granularity: string;
    data: TimeSeriesPoint[];
    summary: MetricsSummary;
  }> {
    const { timespan, granularity } = options;
    const { startTime, endTime } = this.getTimeRange(timespan);
    const bucketInterval = this.getBucketInterval(granularity);

    const data: TimeSeriesPoint[] = [];
    const summaryData = {
      total_requests: 0,
      total_latency: 0,
      total_errors: 0,
      total_request_size: 0,
      total_response_size: 0,
      total_gateway_latency: 0,
      total_provider_latency: 0,
      total_2xx: 0,
      total_4xx: 0,
      total_5xx: 0,
      total_guardrail_count: 0,
      total_guardrail_latency: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
    };

    const buckets = this.getBucketTimestamps(startTime, endTime, bucketInterval);

    for (const bucketTimestamp of buckets) {
      const key = `metrics:${dimension}:${dimensionId}:${granularity}:${bucketTimestamp}`;
      const metrics = await this.redis.hgetall(key);

      const requestCount = parseInt(metrics.request_count || '0');
      const totalLatency = parseInt(metrics.total_latency || '0');
      const gatewayLatency = parseInt(metrics.gateway_latency || '0');
      const providerLatency = parseInt(metrics.provider_latency || '0');
      const errorCount = parseInt(metrics.error_count || '0');
      const requestSize = parseInt(metrics.total_requests_size || '0');
      const responseSize = parseInt(metrics.total_response_size || '0');
      const s2xx = parseInt(metrics.status_2xx || '0');
      const s4xx = parseInt(metrics.status_4xx || '0');
      const s5xx = parseInt(metrics.status_5xx || '0');
      const guardrailCount = parseInt(metrics.guardrail_count || '0');
      const guardrailLatency = parseInt(metrics.guardrail_latency || '0');
      const pTokens = parseInt(metrics.prompt_tokens || '0');
      const cTokens = parseInt(metrics.completion_tokens || '0');
      const crTokens = parseInt(metrics.cache_read_tokens || '0');
      const cwTokens = parseInt(metrics.cache_write_tokens || '0');

      data.push({
        timestamp: bucketTimestamp,
        request_count: requestCount,
        avg_latency: requestCount > 0 ? Math.round(totalLatency / requestCount) : 0,
        avg_gateway_latency: requestCount > 0 ? Math.round(gatewayLatency / requestCount) : 0,
        avg_provider_latency: requestCount > 0 ? Math.round(providerLatency / requestCount) : 0,
        error_rate: requestCount > 0 ? Number((errorCount / requestCount).toFixed(3)) : 0,
        total_request_size: requestSize,
        total_response_size: responseSize,
        status_2xx: s2xx,
        status_4xx: s4xx,
        status_5xx: s5xx,
        guardrail_count: guardrailCount,
        avg_guardrail_latency: guardrailCount > 0 ? Math.round(guardrailLatency / guardrailCount) : 0,
        prompt_tokens: pTokens,
        completion_tokens: cTokens,
        cache_read_tokens: crTokens,
        cache_write_tokens: cwTokens,
      });

      summaryData.total_requests += requestCount;
      summaryData.total_latency += totalLatency;
      summaryData.total_errors += errorCount;
      summaryData.total_request_size += requestSize;
      summaryData.total_response_size += responseSize;
      summaryData.total_gateway_latency += gatewayLatency;
      summaryData.total_provider_latency += providerLatency;
      summaryData.total_2xx += s2xx;
      summaryData.total_4xx += s4xx;
      summaryData.total_5xx += s5xx;
      summaryData.total_guardrail_count += guardrailCount;
      summaryData.total_guardrail_latency += guardrailLatency;
      summaryData.total_prompt_tokens += pTokens;
      summaryData.total_completion_tokens += cTokens;
      summaryData.total_cache_read_tokens += crTokens;
      summaryData.total_cache_write_tokens += cwTokens;
    }

    const summary: MetricsSummary = {
      total_requests: summaryData.total_requests,
      avg_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_latency / summaryData.total_requests)
          : 0,
      avg_gateway_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_gateway_latency / summaryData.total_requests)
          : 0,
      avg_provider_latency:
        summaryData.total_requests > 0
          ? Math.round(summaryData.total_provider_latency / summaryData.total_requests)
          : 0,
      error_rate:
        summaryData.total_requests > 0
          ? Number((summaryData.total_errors / summaryData.total_requests).toFixed(3))
          : 0,
      total_request_size: summaryData.total_request_size,
      total_response_size: summaryData.total_response_size,
      total_2xx: summaryData.total_2xx,
      total_4xx: summaryData.total_4xx,
      total_5xx: summaryData.total_5xx,
      total_guardrail_evaluations: summaryData.total_guardrail_count,
      avg_guardrail_latency:
        summaryData.total_guardrail_count > 0
          ? Math.round(summaryData.total_guardrail_latency / summaryData.total_guardrail_count)
          : 0,
      total_prompt_tokens: summaryData.total_prompt_tokens,
      total_completion_tokens: summaryData.total_completion_tokens,
      total_cache_read_tokens: summaryData.total_cache_read_tokens,
      total_cache_write_tokens: summaryData.total_cache_write_tokens,
    };

    return {
      timespan,
      granularity,
      data,
      summary,
    };
  }

  /**
   * Get top performing items for a dimension
   */
  private async getTopItems(
    dimension: string,
    options: MetricsQueryOptions,
    limit: number = 10,
    organizationId?: string
  ): Promise<TopItem[]> {
    const { timespan, granularity } = options;
    const { startTime, endTime } = this.getTimeRange(timespan);
    const _bucketInterval = this.getBucketInterval(granularity);

    // If organizationId is provided and we're looking for models/users/providers,
    // we need to get them from organization-specific metrics
    let keys: string[];
    let keyPrefix: string;
    if (organizationId) {
      // Use org-specific dimension mappings for filtering
      keyPrefix = `metrics:org:${organizationId}:${dimension}:`;
      const orgDimensionPattern = `${keyPrefix}*:${granularity}:*`;
      keys = await this.scanKeys(orgDimensionPattern);
    } else {
      // Scan Redis for all keys matching the pattern (backward compatibility)
      keyPrefix = `metrics:${dimension}:`;
      const pattern = `${keyPrefix}*:${granularity}:*`;
      keys = await this.scanKeys(pattern);
    }

    // Group by dimension ID and aggregate
    const aggregated: Map<
      string,
      {
        total_requests: number;
        total_latency: number;
        total_errors: number;
        total_2xx: number;
        total_4xx: number;
        total_5xx: number;
        total_prompt_tokens: number;
        total_completion_tokens: number;
        total_cache_read_tokens: number;
        total_cache_write_tokens: number;
      }
    > = new Map();

    for (const key of keys) {
      // Strip the known prefix, leaving: {dimensionId}:{granularity}:{timestamp}
      const suffix = key.slice(keyPrefix.length);
      const suffixParts = suffix.split(':');
      if (suffixParts.length < 3) continue;

      // Last two parts are granularity and timestamp; everything before is the dimension ID
      const timestampPart = suffixParts[suffixParts.length - 1];
      const dimensionId = suffixParts.slice(0, suffixParts.length - 2).join(':');
      const bucketTimestamp = parseInt(timestampPart);

      // Skip sub-dimension keys (e.g., provider:${id}:upstream:${upstreamId})
      // These leak into the parent scan and should only be queried via their own methods
      if (dimensionId.includes(':upstream:') || dimensionId.includes(':model:') || dimensionId.includes(':user:')) {
        continue;
      }

      // Only include keys within time range
      if (bucketTimestamp < startTime || bucketTimestamp > endTime) continue;

      const metrics = await this.redis.hgetall(key);
      const requestCount = parseInt(metrics.request_count || '0');
      const totalLatency = parseInt(metrics.total_latency || '0');
      const errorCount = parseInt(metrics.error_count || '0');
      const s2xx = parseInt(metrics.status_2xx || '0');
      const s4xx = parseInt(metrics.status_4xx || '0');
      const s5xx = parseInt(metrics.status_5xx || '0');
      const pTokens = parseInt(metrics.prompt_tokens || '0');
      const cTokens = parseInt(metrics.completion_tokens || '0');
      const crTokens = parseInt(metrics.cache_read_tokens || '0');
      const cwTokens = parseInt(metrics.cache_write_tokens || '0');

      if (!aggregated.has(dimensionId)) {
        aggregated.set(dimensionId, {
          total_requests: 0,
          total_latency: 0,
          total_errors: 0,
          total_2xx: 0,
          total_4xx: 0,
          total_5xx: 0,
          total_prompt_tokens: 0,
          total_completion_tokens: 0,
          total_cache_read_tokens: 0,
          total_cache_write_tokens: 0,
        });
      }

      const current = aggregated.get(dimensionId)!;
      current.total_requests += requestCount;
      current.total_latency += totalLatency;
      current.total_errors += errorCount;
      current.total_2xx += s2xx;
      current.total_4xx += s4xx;
      current.total_5xx += s5xx;
      current.total_prompt_tokens += pTokens;
      current.total_completion_tokens += cTokens;
      current.total_cache_read_tokens += crTokens;
      current.total_cache_write_tokens += cwTokens;
    }

    // Convert to TopItem array and sort by request count
    const items: TopItem[] = Array.from(aggregated.entries()).map(([id, data]) => {
      return {
        id,
        request_count: data.total_requests,
        avg_latency:
          data.total_requests > 0 ? Math.round(data.total_latency / data.total_requests) : 0,
        error_rate:
          data.total_requests > 0
            ? Number((data.total_errors / data.total_requests).toFixed(3))
            : 0,
        status_2xx: data.total_2xx,
        status_4xx: data.total_4xx,
        status_5xx: data.total_5xx,
        prompt_tokens: data.total_prompt_tokens,
        completion_tokens: data.total_completion_tokens,
        cache_read_tokens: data.total_cache_read_tokens,
        cache_write_tokens: data.total_cache_write_tokens,
      };
    });

    return items.sort((a, b) => b.request_count - a.request_count).slice(0, limit);
  }

  /**
   * Get overall summary across all dimensions
   */
  private async getOverallSummary(
    options: MetricsQueryOptions,
    organizationId?: string
  ): Promise<MetricsSummary> {
    // If organizationId is provided, get metrics from the org dimension directly
    if (organizationId) {
      const orgData = await this.getDimensionMetrics('org', organizationId, options);
      return orgData.summary;
    }

    // For backward compatibility, aggregate from all provider metrics
    const topProviders = await this.getTopItems('provider', options, 1000, organizationId); // Get all providers

    const summary = {
      total_requests: 0,
      total_latency: 0,
      total_errors: 0,
      total_request_size: 0,
      total_response_size: 0,
      total_gateway_latency: 0,
      total_provider_latency: 0,
      total_2xx: 0,
      total_4xx: 0,
      total_5xx: 0,
      total_guardrail_count: 0,
      total_guardrail_latency: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
    };

    for (const provider of topProviders) {
      const providerData = await this.getDimensionMetrics('provider', provider.id, options);
      summary.total_requests += providerData.summary.total_requests;
      summary.total_latency +=
        providerData.summary.avg_latency * providerData.summary.total_requests;
      summary.total_errors += providerData.summary.error_rate * providerData.summary.total_requests;
      summary.total_request_size += providerData.summary.total_request_size;
      summary.total_response_size += providerData.summary.total_response_size;
      summary.total_gateway_latency +=
        providerData.summary.avg_gateway_latency * providerData.summary.total_requests;
      summary.total_provider_latency +=
        providerData.summary.avg_provider_latency * providerData.summary.total_requests;
      summary.total_2xx += providerData.summary.total_2xx;
      summary.total_4xx += providerData.summary.total_4xx;
      summary.total_5xx += providerData.summary.total_5xx;
      summary.total_guardrail_count += providerData.summary.total_guardrail_evaluations;
      summary.total_guardrail_latency +=
        providerData.summary.avg_guardrail_latency * providerData.summary.total_guardrail_evaluations;
      summary.total_prompt_tokens += providerData.summary.total_prompt_tokens;
      summary.total_completion_tokens += providerData.summary.total_completion_tokens;
      summary.total_cache_read_tokens += providerData.summary.total_cache_read_tokens;
      summary.total_cache_write_tokens += providerData.summary.total_cache_write_tokens;
    }

    return {
      total_requests: summary.total_requests,
      avg_latency:
        summary.total_requests > 0 ? Math.round(summary.total_latency / summary.total_requests) : 0,
      avg_gateway_latency:
        summary.total_requests > 0
          ? Math.round(summary.total_gateway_latency / summary.total_requests)
          : 0,
      avg_provider_latency:
        summary.total_requests > 0
          ? Math.round(summary.total_provider_latency / summary.total_requests)
          : 0,
      error_rate:
        summary.total_requests > 0
          ? Number((summary.total_errors / summary.total_requests).toFixed(3))
          : 0,
      total_request_size: summary.total_request_size,
      total_response_size: summary.total_response_size,
      total_2xx: summary.total_2xx,
      total_4xx: summary.total_4xx,
      total_5xx: summary.total_5xx,
      total_guardrail_evaluations: summary.total_guardrail_count,
      avg_guardrail_latency:
        summary.total_guardrail_count > 0
          ? Math.round(summary.total_guardrail_latency / summary.total_guardrail_count)
          : 0,
      total_prompt_tokens: summary.total_prompt_tokens,
      total_completion_tokens: summary.total_completion_tokens,
      total_cache_read_tokens: summary.total_cache_read_tokens,
      total_cache_write_tokens: summary.total_cache_write_tokens,
    };
  }

  /**
   * Get latency trend data
   */
  private async getLatencyTrend(
    options: MetricsQueryOptions,
    organizationId?: string
  ): Promise<TimeSeriesPoint[]> {
    // If organizationId is provided, get org-specific trends
    if (organizationId) {
      const orgData = await this.getDimensionMetrics('org', organizationId, options);
      return orgData.data;
    }

    // Use provider aggregation for overall trends (backward compatibility)
    const topProviders = await this.getTopItems('provider', options, 10, organizationId);

    if (topProviders.length === 0) return [];

    // Get trend from the top provider as a representative sample
    const topProvider = topProviders[0];
    const result = await this.getDimensionMetrics('provider', topProvider.id, options);
    return result.data;
  }

  /**
   * Get error rate trend data
   */
  private async getErrorRateTrend(
    options: MetricsQueryOptions,
    organizationId?: string
  ): Promise<TimeSeriesPoint[]> {
    return this.getLatencyTrend(options, organizationId); // Same logic for now
  }

  /**
   * Get request volume trend data
   */
  private async getRequestVolumeTrend(
    options: MetricsQueryOptions,
    organizationId?: string
  ): Promise<TimeSeriesPoint[]> {
    return this.getLatencyTrend(options, organizationId); // Same logic for now
  }

  /**
   * Utility methods
   */

  private getTimeRange(timespan: string): { startTime: number; endTime: number } {
    const now = Date.now();

    // Determine the bucket interval for this timespan's optimal granularity
    // so we can snap boundaries to bucket edges — prevents oscillation
    // between cached and fresh results when the sliding window shifts
    const granularity = this.getOptimalGranularityForTimespan(timespan);
    const bucketMs = this.getBucketInterval(granularity);

    // Snap endTime UP to the next bucket boundary (includes the current partial bucket)
    const endTime = Math.ceil(now / bucketMs) * bucketMs;

    let duration: number;
    switch (timespan) {
      case '1h':
        duration = 60 * 60 * 1000;
        break;
      case '24h':
        duration = 24 * 60 * 60 * 1000;
        break;
      case '7d':
        duration = 7 * 24 * 60 * 60 * 1000;
        break;
      case '30d':
        duration = 30 * 24 * 60 * 60 * 1000;
        break;
      case '90d':
        duration = 90 * 24 * 60 * 60 * 1000;
        break;
      case '1y':
        duration = 365 * 24 * 60 * 60 * 1000;
        break;
      default:
        duration = 24 * 60 * 60 * 1000;
    }

    // Snap startTime DOWN to the bucket boundary
    const startTime = Math.floor((endTime - duration) / bucketMs) * bucketMs;

    return { startTime, endTime };
  }

  private getOptimalGranularityForTimespan(timespan: string): string {
    switch (timespan) {
      case '1h':
      case '24h':
        return 'hour';
      case '7d':
      case '30d':
        return 'day';
      case '90d':
        return 'week';
      case '1y':
        return 'month';
      default:
        return 'hour';
    }
  }

  private getBucketInterval(granularity: string): number {
    switch (granularity) {
      case 'hour':
        return this.config.aggregationIntervals.hour * 1000;
      case 'day':
        return this.config.aggregationIntervals.day * 1000;
      case 'week':
        return 7 * this.config.aggregationIntervals.day * 1000;
      case 'month':
        return this.config.aggregationIntervals.month * 1000;
      default:
        return this.config.aggregationIntervals.hour * 1000;
    }
  }

  private getBucketTimestamps(
    startTime: number,
    endTime: number,
    bucketInterval: number
  ): number[] {
    const timestamps: number[] = [];

    let current = Math.floor(startTime / bucketInterval) * bucketInterval;
    while (current <= endTime) {
      timestamps.push(current);
      current += bucketInterval;
    }

    return timestamps;
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    return keys;
  }
}
