import { addTarget, removeTarget } from '../kong/upstream.js';
import { updateService, getService } from '../kong/service.js';
import { addPlugin, updatePlugin, removePlugin, getPlugins } from '../kong/plugins.js';
import * as kong from '../kong/client.js';

export async function providerUpdate(command) {
  const { orgSlug, providerSlug, targetUrl, protocol, rateLimit, forwardCallerAuth, logRequestBody, logResponseBody, authToken, upstreamPath, timeoutSeconds } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  const service = await getService(name);
  const { data: plugins } = await getPlugins(service.id);
  const updates = {};

  if (forwardCallerAuth !== undefined) {
    const keyAuthPlugin = plugins.find((p) => p.name === 'key-auth');

    if (forwardCallerAuth && keyAuthPlugin) {
      await removePlugin(keyAuthPlugin.id);
    } else if (!forwardCallerAuth && !keyAuthPlugin) {
      const keyAuth = await addPlugin(service.id, 'key-auth', {
        key_names: ['x-api-key', 'api-key', 'api_key'],
        hide_credentials: true,
      });
      updates.keyAuthPluginId = keyAuth.id;
    }
  }

  // Ensure ACL and bearer-extract plugins exist (backfill for pre-ACL providers)
  if (!forwardCallerAuth) {
    if (!plugins.find((p) => p.name === 'acl')) {
      const aclGroup = `${orgSlug}-${providerSlug}`;
      const acl = await addPlugin(service.id, 'acl', {
        allow: [aclGroup, `org-${orgSlug}`],
        hide_groups_header: true,
      });
      updates.aclPluginId = acl.id;
    }
    if (!plugins.find((p) => p.name === 'pre-function')) {
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
      updates.bearerExtractPluginId = bearerExtract.id;
    }
  }

  if (targetUrl) {
    const targetsData = await kong.get(`/upstreams/${name}/targets`);
    const existingTargets = targetsData?.data || [];

    // Skip target update if the URL hasn't changed
    const alreadyExists = existingTargets.some((t) => t.target === targetUrl);
    if (!alreadyExists) {
      const newTarget = await addTarget(name, targetUrl);
      updates.targetId = newTarget.id;

      for (const t of existingTargets) {
        await removeTarget(name, t.id);
      }
    }
  }

  if (protocol || upstreamPath !== undefined || timeoutSeconds !== undefined) {
    const serviceUpdate = {};
    if (protocol) {
      serviceUpdate.protocol = protocol;
      serviceUpdate.port = protocol === 'https' ? 443 : 80;
    }
    if (upstreamPath !== undefined) {
      serviceUpdate.path = upstreamPath || '/';
    }
    if (timeoutSeconds !== undefined) {
      const timeoutMs = (timeoutSeconds || 300) * 1000;
      serviceUpdate.read_timeout = timeoutMs;
      serviceUpdate.write_timeout = timeoutMs;
    }
    await updateService(name, serviceUpdate);
  }

  if (rateLimit) {
    const rlPlugin = plugins.find((p) => p.name === 'rate-limiting');

    if (rateLimit.removeRateLimit && rlPlugin) {
      // Remove rate-limiting plugin entirely (switching to token limits)
      await removePlugin(rlPlugin.id);
      updates.rateLimitingRemoved = true;
    } else if (rlPlugin) {
      await updatePlugin(rlPlugin.id, {
        minute: null,  // Clear any legacy default minute limit
        hour: rateLimit.hour || null,
        day: rateLimit.day || null,
      });
      updates.rateLimitingPluginId = rlPlugin.id;
    } else if (!rateLimit.removeRateLimit) {
      const newRl = await addPlugin(service.id, 'rate-limiting', {
        hour: rateLimit.hour || undefined,
        day: rateLimit.day || undefined,
        policy: 'local',
      });
      updates.rateLimitingPluginId = newRl.id;
    }
  }

  // Update request-transformer with auth token changes
  if (authToken !== undefined) {
    const reqTransformerPlugin = plugins.find((p) => p.name === 'request-transformer');
    if (reqTransformerPlugin) {
      const existingAddHeaders = reqTransformerPlugin.config?.add?.headers || [];
      const nonAuthHeaders = existingAddHeaders.filter(h => !h.startsWith('Authorization:'));
      const newHeaders = [...nonAuthHeaders];
      if (authToken && !forwardCallerAuth) {
        newHeaders.push(`Authorization:Bearer ${authToken}`);
      }
      const transformUpdate = { add: { headers: newHeaders } };
      if (authToken && !forwardCallerAuth) {
        transformUpdate.remove = { headers: ['Authorization'] };
      } else {
        transformUpdate.remove = { headers: [] };
      }
      await updatePlugin(reqTransformerPlugin.id, transformUpdate);
    }
  }

  // Update http-log custom_fields_by_lua for logging flags
  if (logRequestBody !== undefined || logResponseBody !== undefined) {
    const httpLogPlugin = plugins.find((p) => p.name === 'http-log');
    if (httpLogPlugin) {
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
      await updatePlugin(httpLogPlugin.id, { custom_fields_by_lua: customFieldsByLua });
    }
  }

  // Pre-function scripts are managed via PROVIDER_PREFUNCTION_DEPLOY

  console.log(`[provider-update] ${name} updated`);

  return {
    providerId: command.payload.providerId,
    ...updates,
  };
}
