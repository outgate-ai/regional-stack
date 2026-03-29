/**
 * Environment configuration for the region agent.
 * All config access goes through this module.
 */

let _config = null;

export function getConfig() {
  if (_config) return _config;

  _config = {
    regionId: process.env.REGION_ID || '',
    organizationId: process.env.ORGANIZATION_ID || '',
    sqsQueueUrl: process.env.SQS_QUEUE_URL || '',
    kongAdminUrl: process.env.KONG_ADMIN_URL || 'http://kong:8001',
    webhookUrl: process.env.WEBHOOK_URL || '',
    webhookSecret: process.env.WEBHOOK_SECRET || '',
    pollInterval: parseInt(process.env.POLL_INTERVAL || '20', 10),
    heartbeatUrl: process.env.HEARTBEAT_URL || '',
    heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '60', 10),
    awsRegion: process.env.AWS_REGION || 'eu-central-1',
    guardrailUrl: process.env.GUARDRAIL_URL || 'http://guardrail:3003',
    guardrailApiKey: process.env.GUARDRAIL_API_KEY || process.env.INTERNAL_API_KEY || '',
    logManagerUrl: process.env.LOG_MANAGER_URL || 'http://log-manager:4001',
    regionEndpoint: process.env.REGION_ENDPOINT || '',
    httpPort: parseInt(process.env.HTTP_PORT || '3100', 10),
    httpEnabled: process.env.HTTP_ENABLED === 'true',

    // SQS consumer
    sqsMaxMessages: parseInt(process.env.SQS_MAX_MESSAGES || '10', 10),
    sqsWaitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || '20', 10),
    sqsErrorPollDelayMs: parseInt(process.env.SQS_ERROR_POLL_DELAY_MS || '100', 10),

    // Webhook sender
    webhookMaxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
    webhookBaseRetryDelayMs: parseInt(process.env.WEBHOOK_BASE_RETRY_DELAY_MS || '1000', 10),

    // Heartbeat
    heartbeatStartupDelayMs: parseInt(process.env.HEARTBEAT_STARTUP_DELAY_MS || '30000', 10),
    healthCheckTimeoutMs: parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS || '5000', 10),

    // Kong service names
    kongCommandsServiceName: process.env.KONG_COMMANDS_SERVICE_NAME || 'region-commands',
    kongHealthServiceName: process.env.KONG_HEALTH_SERVICE_NAME || 'region-health',
    kongBffConsumerName: process.env.KONG_BFF_CONSUMER_NAME || 'bff-commands',
    kongCommandsRateLimitMinute: parseInt(process.env.KONG_COMMANDS_RATE_LIMIT_MINUTE || '120', 10),

    // Kong provider defaults
    kongHttpLogTimeoutMs: parseInt(process.env.KONG_HTTP_LOG_TIMEOUT_MS || '10000', 10),
    kongHttpLogKeepaliveMs: parseInt(process.env.KONG_HTTP_LOG_KEEPALIVE_MS || '60000', 10),
    kongHttpLogFlushTimeoutSec: parseInt(process.env.KONG_HTTP_LOG_FLUSH_TIMEOUT_SEC || '2', 10),
    kongHttpLogRetryCount: parseInt(process.env.KONG_HTTP_LOG_RETRY_COUNT || '3', 10),

    // Kong health check thresholds (passive)
    kongHealthCheckSuccesses: parseInt(process.env.KONG_HEALTH_CHECK_SUCCESSES || '3', 10),
    kongHealthCheckHttpFailures: parseInt(process.env.KONG_HEALTH_CHECK_HTTP_FAILURES || '30', 10),
    kongHealthCheckTcpFailures: parseInt(process.env.KONG_HEALTH_CHECK_TCP_FAILURES || '10', 10),
    kongHealthCheckTimeouts: parseInt(process.env.KONG_HEALTH_CHECK_TIMEOUTS || '10', 10),

    // Kong health check (active) — probes unhealthy targets so they can recover
    kongHealthCheckActiveUnhealthyInterval: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_UNHEALTHY_INTERVAL || '5', 10),
    kongHealthCheckActiveUnhealthyHttpFailures: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_UNHEALTHY_HTTP_FAILURES || '3', 10),
    kongHealthCheckActiveUnhealthyTimeouts: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_UNHEALTHY_TIMEOUTS || '3', 10),
    kongHealthCheckActiveHealthyInterval: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_HEALTHY_INTERVAL || '0', 10),
    kongHealthCheckActiveHealthySuccesses: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_HEALTHY_SUCCESSES || '2', 10),
    kongHealthCheckActiveTimeout: parseInt(process.env.KONG_HEALTH_CHECK_ACTIVE_TIMEOUT || '5', 10),
    kongHealthCheckActiveHttpPath: process.env.KONG_HEALTH_CHECK_ACTIVE_HTTP_PATH || '/',

    // Provider defaults
    defaultUpstreamTimeoutSeconds: parseInt(process.env.DEFAULT_UPSTREAM_TIMEOUT_SECONDS || '300', 10),
    disabledProviderStatusCode: parseInt(process.env.DISABLED_PROVIDER_STATUS_CODE || '503', 10),
    disabledProviderBody: process.env.DISABLED_PROVIDER_BODY || '{"error":"Provider is currently disabled"}',

    // Kong Lua
    kongLuaMaxBufferBytes: parseInt(process.env.KONG_LUA_MAX_BUFFER_BYTES || '10485760', 10),

    // Upstream
    defaultTargetWeight: parseInt(process.env.DEFAULT_TARGET_WEIGHT || '100', 10),
  };

  return _config;
}

/** Reset config cache (useful in tests) */
export function resetConfig() {
  _config = null;
}
