import { createUpstream, addTarget } from '../kong/upstream.js';
import { createService } from '../kong/service.js';
import { createRoute } from '../kong/route.js';
import { addPlugin } from '../kong/plugins.js';
import { safeModelDiscovery } from './modelFetch.js';

export async function providerCreate(command) {
  const { orgSlug, providerSlug, targetUrl, protocol = 'https', rateLimit, forwardCallerAuth, baseDomain, authToken, upstreamPath, logRequestBody, logResponseBody } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  const { getConfig: getAgentConfig } = await import('../config.js');
  const agentCfg = getAgentConfig();

  const upstream = await createUpstream(name, {
    healthchecks: {
      passive: {
        healthy: { successes: agentCfg.kongHealthCheckSuccesses },
        unhealthy: { http_failures: agentCfg.kongHealthCheckHttpFailures, tcp_failures: agentCfg.kongHealthCheckTcpFailures, timeouts: agentCfg.kongHealthCheckTimeouts },
      },
      active: {
        type: 'https',
        https_verify_certificate: false,
        http_path: agentCfg.kongHealthCheckActiveHttpPath,
        timeout: agentCfg.kongHealthCheckActiveTimeout,
        healthy: {
          interval: agentCfg.kongHealthCheckActiveHealthyInterval,
          successes: agentCfg.kongHealthCheckActiveHealthySuccesses,
          http_statuses: [200, 201, 202, 204, 301, 302, 400, 401, 403, 404, 405],
        },
        unhealthy: {
          interval: agentCfg.kongHealthCheckActiveUnhealthyInterval,
          http_failures: agentCfg.kongHealthCheckActiveUnhealthyHttpFailures,
          timeouts: agentCfg.kongHealthCheckActiveUnhealthyTimeouts,
          http_statuses: [500, 502, 503, 504],
        },
      },
    },
  });

  const target = await addTarget(name, targetUrl);

  const timeoutMs = (command.payload.timeoutSeconds || agentCfg.defaultUpstreamTimeoutSeconds || 300) * 1000;
  const service = await createService(name, {
    host: name,
    port: protocol === 'https' ? 443 : 80,
    protocol,
    path: upstreamPath || '/',
    connect_timeout: 60000,
    read_timeout: timeoutMs,
    write_timeout: timeoutMs,
  });

  // Use subdomain-based routing when baseDomain is available (wildcard DNS),
  // otherwise fall back to path-based routing (custom domains)
  const routeOpts = baseDomain
    ? { hosts: [`${providerSlug}.${baseDomain}`], paths: ['/'], strip_path: false, preserve_host: false }
    : { paths: [`/${providerSlug}`], strip_path: true, preserve_host: false };

  const route = await createRoute(name, routeOpts);

  const pluginIds = {};

  if (!forwardCallerAuth) {
    // Pre-function to extract Bearer token into x-api-key header for key-auth
    const bearerExtract = await addPlugin(service.id, 'pre-function', {
      access: [`
        local auth = kong.request.get_header("authorization")
        if auth and not kong.request.get_header("x-api-key") then
          local token = auth:match("^[Bb]earer%s+(.+)$")
          if token then
            kong.service.request.set_header("x-api-key", token)
          end
        end
      `.trim()],
    });
    pluginIds.bearerExtract = bearerExtract.id;

    const keyAuth = await addPlugin(service.id, 'key-auth', {
      key_names: ['x-api-key', 'api-key', 'api_key'],
      hide_credentials: true,
    });
    pluginIds.keyAuth = keyAuth.id;

    // ACL plugin to scope API key access per provider
    const aclGroup = `${orgSlug}-${providerSlug}`;
    const acl = await addPlugin(service.id, 'acl', {
      allow: [aclGroup, `org-${orgSlug}`],
      hide_groups_header: true,
    });
    pluginIds.acl = acl.id;
  }

  if (rateLimit) {
    const rateLimiting = await addPlugin(service.id, 'rate-limiting', {
      ...(rateLimit.minute ? { minute: rateLimit.minute } : {}),
      hour: rateLimit.hour || undefined,
      day: rateLimit.day || undefined,
      policy: 'local',
    });
    pluginIds.rateLimiting = rateLimiting.id;
  }

  const transformHeaders = [`X-Outgate-Provider:${providerSlug}`, `X-Outgate-Org:${orgSlug}`];
  if (command.payload.shareId) {
    transformHeaders.push(`X-Outgate-Share:${command.payload.shareId}`);
  }
  const transformConfig = { add: { headers: transformHeaders } };
  if (authToken && !forwardCallerAuth) {
    const authHeaderName = command.payload.authHeaderName || 'Authorization';
    const authHeaderValue = authHeaderName === 'Authorization' ? `Bearer ${authToken}` : authToken;
    transformHeaders.push(`${authHeaderName}:${authHeaderValue}`);
    if (authHeaderName === 'Authorization') {
      transformConfig.remove = { headers: ['Authorization'] };
    }
  }
  const reqTransformer = await addPlugin(service.id, 'request-transformer', transformConfig);
  pluginIds.requestTransformer = reqTransformer.id;

  if (!command.payload.skipHttpLog) {
    const customFieldsByLua = {
      organization_id: `return "${orgSlug}"`,
      request_model: 'return ngx.ctx.request_model or ""',
      correlation_id: 'return kong.request.get_header("X-Correlation-ID") or ""',
    };
    if (logRequestBody) {
      customFieldsByLua.request_body = 'return ngx.ctx.request_body_for_log or ngx.ctx.original_request_body or ""';
    }
    if (logResponseBody) {
      customFieldsByLua.response_body = 'return ngx.ctx.response_body_for_log or ""';
    }

    const httpLog = await addPlugin(service.id, 'http-log', {
      http_endpoint: `${agentCfg.logManagerUrl}/logs/http`,
      method: 'POST',
      content_type: 'application/json',
      timeout: agentCfg.kongHttpLogTimeoutMs,
      keepalive: agentCfg.kongHttpLogKeepaliveMs,
      flush_timeout: agentCfg.kongHttpLogFlushTimeoutSec,
      retry_count: agentCfg.kongHttpLogRetryCount,
      headers: { 'x-internal-api-key': agentCfg.guardrailApiKey || '' },
      custom_fields_by_lua: customFieldsByLua,
    });
    pluginIds.httpLog = httpLog.id;
  }

  // Pre-function scripts are deployed separately via PROVIDER_PREFUNCTION_DEPLOY

  // Fetch and cache available models (fire-and-forget, never blocks creation)
  if (targetUrl && !command.payload.isRouter) {
    safeModelDiscovery({
      providerId: command.payload.providerId,
      url: targetUrl,
      authToken,
    });
  }

  console.log(`[provider-create] ${name} created`);

  return {
    providerId: command.payload.providerId,
    upstreamId: upstream.id,
    targetId: target.id,
    serviceId: service.id,
    routeId: route.id,
    pluginIds,
  };
}
