/**
 * LOG_QUERY command handler.
 * Fetches logs from the local log-manager and returns them
 * via the webhook callback so the BFF can serve them to the console.
 */

import { getConfig } from '../config.js';

/**
 * Query logs from the regional log-manager.
 * @param {object} command - The full command object
 * @param {object} command.payload - Query parameters
 * @param {string} [command.payload.type='http'] - Log type (http or application)
 * @param {number} [command.payload.limit=50] - Max results
 * @param {number} [command.payload.offset=0] - Pagination offset
 * @param {string} [command.payload.providerId] - Filter by provider
 * @param {string} [command.payload.since] - Filter by start date
 * @param {string} [command.payload.status] - Filter by HTTP status
 * @param {string} [command.payload.organizationId] - Organization ID
 * @returns {Promise<object>} Log-manager response
 */
export async function logQuery(command) {
  const config = getConfig();
  const { type = 'http', limit, offset, providerId, since, status, organizationId } = command.payload || {};

  const path = type === 'application' ? '/logs' : '/logs/http';

  const params = new URLSearchParams();
  if (organizationId) params.set('organizationId', organizationId);
  if (limit) params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  if (providerId) params.set('providerId', providerId);
  if (since) params.set('since', since);
  if (status) params.set('status', status);

  const qs = params.toString();
  const url = `${config.logManagerUrl}${path}${qs ? `?${qs}` : ''}`;

  console.log(`[log-query] Fetching: ${url}`);

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
  console.log(`[log-query] Received ${Array.isArray(data) ? data.length : 'object'} result`);

  return { logs: data };
}
