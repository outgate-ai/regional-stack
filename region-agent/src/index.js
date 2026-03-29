/**
 * Region Agent entry point.
 * Supports two connectivity modes:
 * - Private: polls SQS for commands, sends results via webhook callback
 * - Public: exposes HTTP server for direct command execution
 * Both modes send periodic heartbeats to the global BFF.
 */

import { getConfig } from './config.js';
import { startPolling, stopPolling } from './sqsConsumer.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { startHttpServer, stopHttpServer, syncWebhookSecret } from './httpServer.js';
import { rebuildFromKong } from './versionMap.js';
import * as kong from './kong/client.js';

const config = getConfig();

console.log(`[region-agent] Starting region agent for region: ${config.regionId}`);
console.log(`[region-agent] Organization: ${config.organizationId}`);
console.log(`[region-agent] Kong Admin URL: ${config.kongAdminUrl}`);

// Start SQS polling if queue URL is configured (private mode)
if (config.sqsQueueUrl) {
  console.log(`[region-agent] SQS Queue: ${config.sqsQueueUrl}`);
  startPolling(config);
}

// Start HTTP command server if enabled (public mode)
if (config.httpEnabled) {
  console.log(`[region-agent] HTTP server enabled on port ${config.httpPort}`);
  startHttpServer(config);
}

// Sync webhook secret from Kong before starting heartbeat/SQS.
// On rotation, the new secret is persisted in Kong's key-auth credential.
// On restart, this reads it back so .env doesn't need updating.
await syncWebhookSecret(config);

startHeartbeat(config);

// Rebuild script version map from Kong (non-blocking)
rebuildFromKong().catch(err => console.error('[region-agent] Version map rebuild failed:', err.message));

// Ensure global correlation-id plugin exists (idempotent)
kong.post('/plugins', {
  name: 'correlation-id',
  config: { header_name: 'X-Correlation-ID', generator: 'uuid', echo_downstream: true },
}).then(() => console.log('[region-agent] Global correlation-id plugin enabled'))
  .catch(err => {
    if (err.status === 409) console.log('[region-agent] Global correlation-id plugin already exists');
    else console.error('[region-agent] Failed to enable correlation-id plugin:', err.message);
  });

// Graceful shutdown
function shutdown(signal) {
  console.log(`[region-agent] Received ${signal}, shutting down gracefully...`);
  stopHeartbeat();
  stopPolling();
  stopHttpServer();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[region-agent] Agent is running. Press Ctrl+C to stop.');
