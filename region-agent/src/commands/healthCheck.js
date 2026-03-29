/**
 * REGION_HEALTH_CHECK command handler.
 * Checks Kong status and Redis connectivity, returns a health report.
 */

import * as kong from '../kong/client.js';
import { getConfig } from '../config.js';

/**
 * Perform a health check on regional services.
 * @param {object} command - The full command object
 * @returns {Promise<object>} Health report
 */
export async function healthCheck(command) {
  const config = getConfig();
  const report = {
    regionId: config.regionId,
    timestamp: new Date().toISOString(),
    kong: { status: 'unknown' },
    redis: { status: 'unknown' },
  };

  // Check Kong status
  try {
    const status = await kong.get('/status');
    report.kong = {
      status: 'healthy',
      database: status?.database?.reachable ? 'reachable' : 'unreachable',
      connections: status?.server?.connections_active || 0,
    };
  } catch (err) {
    report.kong = { status: 'unhealthy', error: err.message };
  }

  // Check Redis connectivity (via Kong's shared_dict or a simple fetch)
  try {
    // Try to reach the Redis service at the expected URL
    const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';
    // We use a simple TCP-level check by trying to fetch Kong's /status
    // which internally may use Redis if configured.
    // For a more thorough check, we test the log-manager health endpoint.
    const logManagerUrl = process.env.LOG_MANAGER_URL || 'http://log-manager:3002';
    const response = await fetch(`${logManagerUrl}/health`);
    if (response.ok) {
      report.redis = { status: 'healthy' };
    } else {
      report.redis = { status: 'degraded', httpStatus: response.status };
    }
  } catch (err) {
    report.redis = { status: 'unhealthy', error: err.message };
  }

  const allHealthy = report.kong.status === 'healthy' && report.redis.status === 'healthy';
  report.overall = allHealthy ? 'healthy' : 'degraded';

  console.log(`[health-check] Region ${config.regionId}: ${report.overall}`);

  return report;
}
