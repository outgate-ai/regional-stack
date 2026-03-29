/**
 * Command router.
 * Maps command types to their handler functions and wraps execution
 * with consistent error handling.
 */

import { providerCreate } from './commands/providerCreate.js';
import { providerUpdate } from './commands/providerUpdate.js';
import { providerDelete } from './commands/providerDelete.js';
import { providerToggle } from './commands/providerToggle.js';
import { guardrailToggle } from './commands/guardrailToggle.js';
import { guardrailPolicySync, guardrailPolicyDelete } from './commands/guardrailPolicySync.js';
import { rateLimitUpdate } from './commands/rateLimitUpdate.js';
import { apiKeyCreate } from './commands/apiKeyCreate.js';
import { apiKeyRevoke } from './commands/apiKeyRevoke.js';
import { healthCheck } from './commands/healthCheck.js';
import { logQuery } from './commands/logQuery.js';
import { logBodyFetch } from './commands/logBodyFetch.js';
import { metricsQuery } from './commands/metricsQuery.js';
import { modelFetch } from './commands/modelFetch.js';
import { modelQuery } from './commands/modelQuery.js';
import { toolMonitoringToggle } from './commands/toolMonitoringToggle.js';
import { toolQuery } from './commands/toolQuery.js';
import { toolFilterSync } from './commands/toolFilterSync.js';
import { prefunctionDeploy } from './commands/prefunctionDeploy.js';
import { scriptStatus } from './commands/scriptStatus.js';
import { aclBackfill } from './commands/aclBackfill.js';
import { routerCreate } from './commands/routerCreate.js';
import { routerUpdate } from './commands/routerUpdate.js';
import { routerDelete } from './commands/routerDelete.js';

const handlers = {
  PROVIDER_CREATE: providerCreate,
  PROVIDER_UPDATE: providerUpdate,
  PROVIDER_DELETE: providerDelete,
  PROVIDER_ENABLE: providerToggle,
  PROVIDER_DISABLE: providerToggle,
  PROVIDER_GUARDRAIL_ENABLE: guardrailToggle,
  PROVIDER_GUARDRAIL_DISABLE: guardrailToggle,
  GUARDRAIL_POLICY_SYNC: guardrailPolicySync,
  GUARDRAIL_POLICY_DELETE: guardrailPolicyDelete,
  PROVIDER_RATE_LIMIT_UPDATE: rateLimitUpdate,
  APIKEY_CREATE: apiKeyCreate,
  APIKEY_REVOKE: apiKeyRevoke,
  REGION_HEALTH_CHECK: healthCheck,
  LOG_QUERY: logQuery,
  LOG_BODY_FETCH: logBodyFetch,
  METRICS_QUERY: metricsQuery,
  MODEL_FETCH: modelFetch,
  MODEL_QUERY: modelQuery,
  PROVIDER_TOOL_MONITORING_TOGGLE: toolMonitoringToggle,
  PROVIDER_TOOL_FILTER_SYNC: toolFilterSync,
  TOOL_QUERY: toolQuery,
  PROVIDER_PREFUNCTION_DEPLOY: prefunctionDeploy,
  PROVIDER_SCRIPT_STATUS: scriptStatus,
  ACL_BACKFILL: aclBackfill,
  ROUTER_CREATE: routerCreate,
  ROUTER_UPDATE: routerUpdate,
  ROUTER_DELETE: routerDelete,
};

/**
 * Route a command to the appropriate handler.
 * @param {object} command - The full command object from SQS
 * @returns {Promise<{status: string, result: object}>}
 */
export async function routeCommand(command) {
  const handler = handlers[command.type];

  if (!handler) {
    console.error(`[router] Unknown command type: ${command.type}`);
    return { status: 'FAILED', result: { error: `Unknown command type: ${command.type}` } };
  }

  try {
    const result = await handler(command);
    return { status: 'SUCCESS', result: result || {} };
  } catch (err) {
    console.error(`[router] Command ${command.type} failed:`, err.message);
    return { status: 'FAILED', result: { error: err.message } };
  }
}
