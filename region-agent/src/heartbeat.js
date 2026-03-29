/**
 * Heartbeat sender.
 * Periodically reports region health and version info to the global BFF.
 * The BFF may respond with key rotation instructions (handled in Phase 4).
 */

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

let _timer = null;
let _running = false;
const startTime = Date.now();

/**
 * Start the heartbeat loop.
 * @param {object} config - Application configuration
 */
export function startHeartbeat(config) {
  if (!config.heartbeatUrl) {
    console.log('[heartbeat] No HEARTBEAT_URL configured, heartbeat disabled');
    return;
  }

  _running = true;
  const intervalSeconds = config.heartbeatInterval || 60;
  const intervalMs = intervalSeconds * 1000;
  const startupDelayMs = config.heartbeatStartupDelayMs;
  console.log(`[heartbeat] Starting heartbeat every ${intervalSeconds}s to ${config.heartbeatUrl} (first in ${startupDelayMs / 1000}s)`);

  // Delay the first heartbeat so log-manager/redis/guardrail have time to start
  setTimeout(() => {
    if (!_running) return;
    sendHeartbeat(config);

    // Then repeat on interval
    _timer = setInterval(() => {
      if (_running) sendHeartbeat(config);
    }, intervalMs);
  }, startupDelayMs);
}

/**
 * Stop the heartbeat loop.
 */
export function stopHeartbeat() {
  _running = false;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  console.log('[heartbeat] Stopped');
}

/**
 * Collect local stack status and send heartbeat to the BFF.
 */
async function sendHeartbeat(config) {
  try {
    const { stackStatus, versions: componentVersions } = await collectStackInfo(config);

    const versions = { agent: pkg.version, ...componentVersions };

    const payload = {
      regionId: config.regionId,
      organizationId: config.organizationId,
      timestamp: new Date().toISOString(),
      versions,
      stackStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      heartbeatInterval: config.heartbeatInterval || 60,
      ...(config.regionEndpoint && { endpoint: config.regionEndpoint }),
    };

    const body = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');

    const response = await fetch(config.heartbeatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
        'X-Region-Id': config.regionId,
      },
      body,
    });

    if (!response.ok) {
      console.error(`[heartbeat] Server responded with ${response.status}: ${response.statusText}`);
      return;
    }

    const data = await response.json();
    console.log(`[heartbeat] Sent successfully — rotateKey: ${data.rotateKey || false}`);

    // Handle webhook secret rotation
    if (data.rotateKey && data.newSecret) {
      config.webhookSecret = data.newSecret;
      // Update Kong consumer key-auth credential so it accepts the new secret
      try {
        const kongAdminUrl = config.kongAdminUrl || 'http://kong:8001';
        const consumerName = config.kongBffConsumerName || 'bff-commands';
        const consumerRes = await fetch(`${kongAdminUrl}/consumers/${consumerName}`);
        if (consumerRes.ok) {
          const consumer = await consumerRes.json();
          const keysRes = await fetch(`${kongAdminUrl}/consumers/${consumer.id}/key-auth`);
          const { data: existingKeys } = await keysRes.json();
          if (existingKeys?.length) {
            for (const k of existingKeys) {
              await fetch(`${kongAdminUrl}/consumers/${consumer.id}/key-auth/${k.id}`, { method: 'DELETE' });
            }
          }
          await fetch(`${kongAdminUrl}/consumers/${consumer.id}/key-auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: data.newSecret }),
          });
        }
      } catch (err) {
        console.error('[heartbeat] Failed to update Kong consumer key:', err.message);
      }
      console.log(`[heartbeat] Rotated webhook secret to version ${data.newVersion}`);
    }

    // Handle AWS credential rotation
    if (data.rotateAwsCredentials && data.newAwsAccessKeyId && data.newAwsSecretAccessKey) {
      process.env.AWS_ACCESS_KEY_ID = data.newAwsAccessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = data.newAwsSecretAccessKey;
      try {
        const { resetSqsClient } = await import('./sqsConsumer.js');
        resetSqsClient();
      } catch { /* SQS consumer may not be running (public regions) */ }
      console.log(`[heartbeat] Rotated AWS credentials — new key: ${data.newAwsAccessKeyId.slice(0, 8)}...`);
    }
  } catch (err) {
    console.error('[heartbeat] Failed to send heartbeat:', err.message);
  }
}

/**
 * Probe local services to determine stack health and collect versions.
 * @returns {{ stackStatus: object, versions: object }}
 */
async function collectStackInfo(config) {
  const status = { kong: 'down', redis: 'down', database: 'healthy', logManager: 'down', guardrail: 'down' };
  const versions = {};
  const timeout = config.healthCheckTimeoutMs;

  // Kong status + database reachability
  try {
    const kongRes = await fetch(`${config.kongAdminUrl}/status`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (kongRes.ok) {
      const kongData = await kongRes.json();
      status.kong = 'healthy';
      if (kongData.database?.reachable === false) {
        status.database = 'down';
      }
    } else {
      status.kong = 'degraded';
    }
  } catch {
    status.kong = 'down';
  }

  // Kong version
  try {
    const nodeRes = await fetch(`${config.kongAdminUrl}/`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (nodeRes.ok) {
      const nodeData = await nodeRes.json();
      if (nodeData.version) versions.kong = nodeData.version;
    }
  } catch {
    // Non-critical
  }

  // Log-manager health + version (also tells us Redis is reachable)
  try {
    const healthRes = await fetch(`${config.logManagerUrl}/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (healthRes.ok) {
      status.logManager = 'healthy';
      status.redis = 'healthy';
    } else {
      status.logManager = 'degraded';
    }
  } catch {
    // Log-manager unreachable — redis status stays 'down'
  }

  // Log-manager version (via metrics health endpoint)
  try {
    const metricsRes = await fetch(`${config.logManagerUrl}/metrics/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (metricsRes.ok) {
      const metricsData = await metricsRes.json();
      if (metricsData.version) versions.logManager = metricsData.version;
    }
  } catch {
    // Non-critical
  }

  // Guardrail health + version
  try {
    const guardRes = await fetch(`${config.guardrailUrl}/`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (guardRes.ok) {
      const guardData = await guardRes.json();
      status.guardrail = guardData.status === 'running' ? 'healthy' : 'degraded';
      if (guardData.version) versions.guardrail = guardData.version;
    } else {
      status.guardrail = 'degraded';
    }
  } catch {
    status.guardrail = 'down';
  }

  return { stackStatus: status, versions };
}

