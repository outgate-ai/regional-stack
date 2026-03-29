/**
 * METRICS_QUERY command handler.
 * Fetches metrics from the local log-manager and returns them
 * via the webhook callback so the BFF can serve them to the console.
 */

import { getConfig } from '../config.js';

/**
 * Query metrics from the regional log-manager.
 * @param {object} command - The full command object
 * @param {object} command.payload - Query parameters
 * @param {string} command.payload.path - Metrics endpoint path (e.g., '/metrics/dashboard')
 * @param {object} [command.payload.params] - Query parameters to forward
 * @returns {Promise<object>} Log-manager metrics response
 */
export async function metricsQuery(command) {
  const config = getConfig();
  const { path, params = {} } = command.payload || {};

  if (!path) throw new Error('METRICS_QUERY requires payload.path');

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  }

  const qs = searchParams.toString();
  const url = `${config.logManagerUrl}${path}${qs ? `?${qs}` : ''}`;

  console.log(`[metrics-query] Fetching: ${url}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': config.guardrailApiKey || '',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Log-manager returned ${response.status}: ${body}`);
  }

  const data = await response.json();
  console.log(`[metrics-query] Received response for ${path}`);

  return { metrics: data };
}
