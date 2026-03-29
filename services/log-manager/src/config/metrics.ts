import { parseEnvInt, parseEnvBool } from '@outgate/shared';
import { MetricsConfiguration } from '../services/MetricsCollector';

/**
 * Load metrics configuration from environment variables
 */
export function loadMetricsConfiguration(): MetricsConfiguration & { enabled: boolean } {
  const enabled = parseEnvBool(process.env.METRICS_ENABLED, true);

  const retentionPeriodSeconds = parseEnvInt(
    process.env.METRICS_RETENTION_SECONDS,
    365 * 24 * 60 * 60 // 1 year default
  );

  const hourInterval = parseEnvInt(process.env.METRICS_HOUR_INTERVAL, 60 * 60); // 1 hour
  const dayInterval = parseEnvInt(process.env.METRICS_DAY_INTERVAL, 24 * 60 * 60); // 1 day
  const monthInterval = parseEnvInt(process.env.METRICS_MONTH_INTERVAL, 30 * 24 * 60 * 60); // 30 days

  const dimensionsStr = process.env.METRICS_DIMENSIONS || 'model,user,org,provider';
  const dimensions = dimensionsStr
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d);

  const config: MetricsConfiguration & { enabled: boolean } = {
    enabled,
    retentionPeriodSeconds,
    aggregationIntervals: {
      hour: hourInterval,
      day: dayInterval,
      month: monthInterval,
    },
    dimensions,
  };

  // Validation
  if (config.retentionPeriodSeconds < 24 * 60 * 60) {
    // Minimum 1 day
    throw new Error('METRICS_RETENTION_SECONDS must be at least 86400 (1 day)');
  }

  if (config.retentionPeriodSeconds > 2 * 365 * 24 * 60 * 60) {
    // Maximum 2 years
    throw new Error('METRICS_RETENTION_SECONDS cannot exceed 63072000 (2 years)');
  }

  if (config.aggregationIntervals.hour < 60) {
    // Minimum 1 minute
    throw new Error('METRICS_HOUR_INTERVAL must be at least 60 seconds');
  }

  if (config.aggregationIntervals.day < 60 * 60) {
    // Minimum 1 hour
    throw new Error('METRICS_DAY_INTERVAL must be at least 3600 seconds');
  }

  if (config.aggregationIntervals.month < 24 * 60 * 60) {
    // Minimum 1 day
    throw new Error('METRICS_MONTH_INTERVAL must be at least 86400 seconds');
  }

  if (config.dimensions.length === 0) {
    throw new Error('METRICS_DIMENSIONS must include at least one dimension');
  }

  // Validate dimension names
  const validDimensions = ['model', 'user', 'org', 'provider'];
  for (const dimension of config.dimensions) {
    if (!validDimensions.includes(dimension)) {
      throw new Error(
        `Invalid dimension "${dimension}". Valid dimensions: ${validDimensions.join(', ')}`
      );
    }
  }

  return config;
}

/**
 * Validate timespan parameter
 */
export function validateTimespan(timespan: string): boolean {
  const validTimespans = ['1h', '24h', '7d', '30d', '90d', '1y'];
  return validTimespans.includes(timespan);
}

/**
 * Validate granularity parameter
 */
export function validateGranularity(granularity: string): boolean {
  const validGranularities = ['hour', 'day', 'week', 'month'];
  return validGranularities.includes(granularity);
}

/**
 * Get optimal granularity for a given timespan
 */
export function getOptimalGranularity(timespan: string): string {
  switch (timespan) {
    case '1h':
      return 'hour';
    case '24h':
      return 'hour';
    case '7d':
      return 'day';
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
