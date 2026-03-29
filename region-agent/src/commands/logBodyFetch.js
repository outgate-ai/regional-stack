/**
 * LOG_BODY_FETCH command handler.
 * Fetches request/response body for a specific log entry from the log-manager.
 */

import { getConfig } from '../config.js';

/**
 * Fetch log body from the regional log-manager.
 * @param {object} command - The full command object
 * @param {object} command.payload
 * @param {string} command.payload.logId - The log entry ID
 * @param {string} command.payload.organizationId - Organization ID for access check
 * @returns {Promise<object>} { id, requestBody, responseBody }
 */
export async function logBodyFetch(command) {
  const config = getConfig();
  const { logId, organizationId } = command.payload || {};

  if (!logId) throw new Error('logId is required');

  const url = `${config.logManagerUrl}/logs/http/${logId}/body?organizationId=${encodeURIComponent(organizationId || '')}`;

  console.log(`[log-body-fetch] Fetching: ${url}`);

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

  return response.json();
}
