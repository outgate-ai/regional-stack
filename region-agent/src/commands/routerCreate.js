/**
 * ROUTER_CREATE command handler.
 * Sets up Kong resources for a router provider with unified Lua-based routing.
 *
 * Both subdomain and path-based modes use the same approach:
 * A pre-function Lua script in the access phase handles caller auth validation,
 * sequential failover to upstreams via resty.http, and clean 503 on all-fail.
 *
 * No Kong upstreams or targets are created — routing is fully controlled by Lua.
 */

import { createService } from '../kong/service.js';
import { createRoute } from '../kong/route.js';
import { addPlugin } from '../kong/plugins.js';

/**
 * Generate Lua snippet to extract token counts from a buffered response body.
 * Handles Ollama, OpenAI, and Anthropic formats (both streaming NDJSON/SSE and non-streaming JSON).
 */
function luaTokenExtraction() {
  return `
      -- Extract token counts from response body for metrics
      if resp_body and resp_body ~= "" then
        local cjson_safe = require "cjson.safe"
        local p_tok, c_tok, cr_tok, cw_tok = 0, 0, 0, 0
        local tok_ok, tok_parsed = pcall(cjson_safe.decode, resp_body)
        if tok_ok and tok_parsed then
          -- Non-streaming JSON: Ollama, OpenAI, or Anthropic
          if tok_parsed.prompt_eval_count then
            p_tok = tok_parsed.prompt_eval_count
            c_tok = tok_parsed.eval_count or 0
          elseif tok_parsed.usage then
            if tok_parsed.usage.prompt_tokens then
              -- OpenAI format
              p_tok = tok_parsed.usage.prompt_tokens
              c_tok = tok_parsed.usage.completion_tokens or 0
              if tok_parsed.usage.prompt_tokens_details and tok_parsed.usage.prompt_tokens_details.cached_tokens then
                cr_tok = tok_parsed.usage.prompt_tokens_details.cached_tokens
              end
            else
              -- Anthropic format: input_tokens excludes cache — sum all three
              p_tok = (tok_parsed.usage.input_tokens or 0) + (tok_parsed.usage.cache_creation_input_tokens or 0) + (tok_parsed.usage.cache_read_input_tokens or 0)
              c_tok = tok_parsed.usage.output_tokens or 0
              cr_tok = tok_parsed.usage.cache_read_input_tokens or 0
              cw_tok = tok_parsed.usage.cache_creation_input_tokens or 0
            end
          end
        else
          -- Streaming: scan lines for token data (NDJSON or SSE)
          for line in resp_body:gmatch("[^\n]+") do
            local raw = line
            if raw:sub(1, 6) == "data: " then raw = raw:sub(7) end
            if raw ~= "" and raw ~= "[DONE]" then
              local lk, ld = pcall(cjson_safe.decode, raw)
              if lk and ld then
                if ld.done and ld.prompt_eval_count then
                  p_tok = ld.prompt_eval_count
                  c_tok = ld.eval_count or 0
                elseif ld.usage and ld.usage.prompt_tokens then
                  -- OpenAI streaming usage chunk
                  p_tok = ld.usage.prompt_tokens
                  c_tok = ld.usage.completion_tokens or 0
                  if ld.usage.prompt_tokens_details and ld.usage.prompt_tokens_details.cached_tokens then
                    cr_tok = ld.usage.prompt_tokens_details.cached_tokens
                  end
                elseif ld.type == "message_start" and ld.message and ld.message.usage then
                  -- Anthropic: sum input + cache tokens
                  local u = ld.message.usage
                  p_tok = (u.input_tokens or 0) + (u.cache_creation_input_tokens or 0) + (u.cache_read_input_tokens or 0)
                  cr_tok = u.cache_read_input_tokens or 0
                  cw_tok = u.cache_creation_input_tokens or 0
                elseif ld.type == "message_delta" and ld.usage then
                  c_tok = ld.usage.output_tokens or 0
                end
              end
            end
          end
        end
        if p_tok > 0 then kong.log.set_serialize_value("prompt_tokens", p_tok) end
        if c_tok > 0 then kong.log.set_serialize_value("completion_tokens", c_tok) end
        if cr_tok > 0 then kong.log.set_serialize_value("cache_read_tokens", cr_tok) end
        if cw_tok > 0 then kong.log.set_serialize_value("cache_write_tokens", cw_tok) end
      end`;
}

/**
 * Generate Lua snippet to check token quota against Redis before routing.
 * Returns early with 429 if any window limit is exceeded.
 */
function luaTokenQuotaCheck(tokenLimitHour, tokenLimitDay, tokenLimitMonth, providerId) {
  if (!tokenLimitHour && !tokenLimitDay && !tokenLimitMonth) return '';
  const h = tokenLimitHour || 0;
  const d = tokenLimitDay || 0;
  const m = tokenLimitMonth || 0;
  return `
-- Token quota check
do
  local t_limit_hour = ${h}
  local t_limit_day = ${d}
  local t_limit_month = ${m}
  if t_limit_hour > 0 or t_limit_day > 0 or t_limit_month > 0 then
    local redis = require "resty.redis"
    local red = redis:new()
    red:set_timeouts(1000, 1000, 1000)
    local rok = red:connect("\${process.env.REDIS_HOST || 'redis'}", \${process.env.REDIS_PORT || 6379})
    if rok then
      red:auth("\${process.env.REDIS_PASSWORD || ''}")
      local now = ngx.time()
      local blocked = false
      local block_window = ""
      local block_reset = 0
      local checks = {}
      if t_limit_hour > 0 then
        local b = math.floor(now / 3600) * 3600
        table.insert(checks, {name="hour", limit=t_limit_hour, bucket=b, ttl=3600})
      end
      if t_limit_day > 0 then
        local b = math.floor(now / 86400) * 86400
        table.insert(checks, {name="day", limit=t_limit_day, bucket=b, ttl=86400})
      end
      if t_limit_month > 0 then
        local dt = os.date("!*t", now)
        local b = os.time({year=dt.year, month=dt.month, day=1, hour=0, min=0, sec=0})
        table.insert(checks, {name="month", limit=t_limit_month, bucket=b, ttl=2678400})
      end
      for _, c in ipairs(checks) do
        local key = "token_quota:router:${providerId}:" .. c.name .. ":" .. c.bucket
        local used = tonumber(red:get(key)) or 0
        if used >= c.limit then
          blocked = true
          block_window = c.name
          block_reset = c.bucket + c.ttl
        end
      end
      red:set_keepalive(10000, 100)
      if blocked then
        local retry_after = block_reset - now
        if retry_after < 0 then retry_after = 0 end
        local cjson = require "cjson.safe"
        kong.response.exit(429, cjson.encode({
          message = "API token limit exceeded",
        }), {
          ["Content-Type"] = "application/json",
          ["RateLimit-Limit"] = tostring(block_reset),
          ["RateLimit-Remaining"] = "0",
          ["RateLimit-Reset"] = tostring(block_reset),
          ["X-TokenLimit-Limit"] = tostring(block_reset),
          ["X-TokenLimit-Remaining"] = "0",
          ["X-TokenLimit-Reset"] = tostring(block_reset),
          ["X-TokenLimit-Window"] = block_window,
          ["Retry-After"] = tostring(retry_after),
        })
        return
      end
    end
  end
end
`;
}

export async function routerCreate(command) {
  const {
    orgSlug, providerSlug, baseDomain,
    upstreams, // [{ providerId, providerSlug }] ordered by priority
    internalApiKey,
    routerType,
    tokenLimitHour, tokenLimitDay, tokenLimitMonth,
  } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  const { getConfig: getAgentConfig } = await import('../config.js');
  const agentCfg = getAgentConfig();

  const isSubdomain = !!baseDomain;

  // 1. Create service (dummy backend — Lua handles all routing)
  const service = await createService(name, {
    host: '127.0.0.1',
    port: 65535,
    protocol: 'http',
    path: '/',
    retries: 0,
    connect_timeout: 1000,
  });

  // 2. Create route
  const routeOpts = isSubdomain
    ? { hosts: [`${providerSlug}.${baseDomain}`], paths: ['/'], strip_path: false, preserve_host: false }
    : { paths: [`/${providerSlug}`], strip_path: true, preserve_host: false };

  const route = await createRoute(name, routeOpts);

  // 3. Add plugins
  const pluginIds = {};

  // Routing pre-function (handles auth + routing + error response)
  const effectiveRouterType = routerType || 'failover';
  let routingScript;
  const tokenQuotaLua = luaTokenQuotaCheck(tokenLimitHour, tokenLimitDay, tokenLimitMonth, providerSlug);
  if (effectiveRouterType === 'smart') {
    routingScript = tokenQuotaLua + buildSmartRoutingScript(upstreams, internalApiKey, baseDomain, providerSlug, orgSlug);
  } else if (effectiveRouterType === 'weighted') {
    routingScript = tokenQuotaLua + buildWeightedRoutingScript(upstreams, internalApiKey, baseDomain, providerSlug);
  } else {
    routingScript = tokenQuotaLua + buildUnifiedRoutingScript(upstreams, internalApiKey, baseDomain, providerSlug);
  }
  const preFunction = await addPlugin(service.id, 'pre-function', {
    access: [routingScript],
  });
  pluginIds.preFunction = preFunction.id;

  // Key-auth (defense-in-depth — does not fire when pre-function short-circuits,
  // but documents the auth requirement and serves as fallback)
  const keyAuth = await addPlugin(service.id, 'key-auth', {
    key_names: ['x-api-key', 'api-key', 'api_key'],
    hide_credentials: true,
  });
  pluginIds.keyAuth = keyAuth.id;

  // ACL — allow access from all upstream providers' groups + org-level
  const aclGroups = upstreams.map(u => `${orgSlug}-${u.providerId}`);
  aclGroups.push(`org-${orgSlug}`);
  aclGroups.push(`${orgSlug}-${providerSlug}`);

  const acl = await addPlugin(service.id, 'acl', {
    allow: aclGroups,
    hide_groups_header: true,
  });
  pluginIds.acl = acl.id;

  // Request transformer — metadata headers (internal key is handled by Lua script)
  const reqTransformer = await addPlugin(service.id, 'request-transformer', {
    add: {
      headers: [
        `X-Outgate-Provider:${providerSlug}`,
        `X-Outgate-Org:${orgSlug}`,
      ],
    },
  });
  pluginIds.requestTransformer = reqTransformer.id;

  // HTTP log
  const customFieldsByLua = {
    organization_id: `return "${orgSlug}"`,
    request_model: 'return ngx.ctx.request_model or ""',
    correlation_id: 'return kong.request.get_header("X-Correlation-ID") or ""',
  };
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

  console.log(`[router-create] ${name} created (${isSubdomain ? 'subdomain' : 'path-based'} mode, ${upstreams.length} upstreams, ${effectiveRouterType}, lua-routed)`);

  return {
    providerId: command.payload.providerId,
    serviceId: service.id,
    routeId: route.id,
    pluginIds,
  };
}

/**
 * Build the unified Lua routing script for router providers.
 *
 * Handles:
 * 1. Bearer token extraction (Authorization: Bearer → x-api-key)
 * 2. Caller API key validation via Kong admin API
 * 3. Sequential failover to upstreams via resty.http
 * 4. Clean 503 JSON response when all upstreams fail
 *
 * @param {Array} upstreams - Ordered upstream list [{ providerId }]
 * @param {string} internalApiKey - Internal API key for router→upstream auth
 * @param {string} baseDomain - Region base domain (empty for path-based)
 */
function buildUnifiedRoutingScript(upstreams, internalApiKey, baseDomain, routerSlug) {
  const isSubdomain = !!baseDomain;

  const upstreamEntries = upstreams.map((u, i) => {
    const timeoutMs = (u.timeout || 60) * 1000;
    const modelOverride = u.modelOverride ? `, model_override = "${u.modelOverride.replace(/"/g, '\\"')}"` : '';
    const upstreamLabel = u.modelOverride ? `${u.providerId}:${u.modelOverride}` : u.providerId;
    if (isSubdomain) {
      return `  { id = "${u.providerId}", label = "${upstreamLabel}", host = "${u.providerId}.${baseDomain}", port = 443, protocol = "https", path_prefix = "", timeout = ${timeoutMs}${modelOverride} }`;
    } else {
      return `  { id = "${u.providerId}", label = "${upstreamLabel}", host = "kong", port = 8000, protocol = "http", path_prefix = "/${u.providerId}", timeout = ${timeoutMs}${modelOverride} }`;
    }
  });

  return `
-- Router unified routing script (generated by routerCreate.js)
-- Handles: bearer extract, caller auth, failover routing, error response

-- 1. Extract caller API key (bearer token or x-api-key header)
local caller_key = kong.request.get_header("x-api-key")
if not caller_key then
  local auth = kong.request.get_header("authorization")
  if auth then
    caller_key = auth:match("^[Bb]earer%s+(.+)$")
  end
end
if not caller_key then
  local apikey = kong.request.get_header("api-key") or kong.request.get_header("api_key")
  if apikey then caller_key = apikey end
end
if not caller_key then
  kong.response.exit(401, '{"error":"Missing API key. Provide x-api-key header or Authorization: Bearer token."}', {
    ["Content-Type"] = "application/json",
  })
  return
end

local http = require "resty.http"

-- 2. Validate caller key via Kong admin API (~1ms localhost call)
local admin = http.new()
admin:set_timeout(5000)
local aok, aerr = admin:connect("kong", 8001)
if aok then
  local ares = admin:request({
    method = "GET",
    path = "/key-auths/" .. caller_key,
    headers = { ["Host"] = "kong" },
  })
  if not ares or ares.status ~= 200 then
    admin:close()
    kong.response.exit(401, '{"error":"Invalid API key"}', {
      ["Content-Type"] = "application/json",
    })
    return
  end
  admin:close()
else
  kong.log.err("Failed to connect to Kong admin for key validation: ", aerr)
end

-- 3. Route to upstreams (failover: try each in order, return first non-5xx)
local upstreams = {
${upstreamEntries.join(',\n')}
}
local api_key = "${internalApiKey || ''}"

local method = kong.request.get_method()
local path = kong.request.get_path() or "/"
${!isSubdomain ? `-- Strip router prefix for path-based routing
local router_prefix = "/${routerSlug}"
if path:sub(1, #router_prefix) == router_prefix then
  path = path:sub(#router_prefix + 1)
  if path == "" then path = "/" end
end` : ''}
local query = kong.request.get_raw_query()
local body = kong.request.get_raw_body()
if not body then
  ngx.req.read_body()
  body = ngx.req.get_body_data()
end
local headers = kong.request.get_headers()
headers["host"] = nil
headers["x-api-key"] = api_key
headers["accept-encoding"] = "identity"

local last_err = nil

for i, u in ipairs(upstreams) do
  local httpc = http.new()
  httpc:set_timeout(u.timeout or 60000)

  local ok, conn_err = httpc:connect(u.host, u.port)
  if ok then
    if u.protocol == "https" then
      local _, ssl_err = httpc:ssl_handshake(nil, u.host, false)
      if ssl_err then
        last_err = "upstream " .. u.id .. ": ssl error"
        httpc:close()
        goto continue
      end
    end

    local upstream_path = u.path_prefix .. path
    if query and query ~= "" then
      upstream_path = upstream_path .. "?" .. query
    end

    local req_headers = {}
    for k, v in pairs(headers) do
      req_headers[k] = v
    end
    req_headers["Host"] = u.host

    -- Model override: replace model field in JSON body if configured
    local req_body = body
    if u.model_override and body then
      local cjson = require "cjson.safe"
      local ok, parsed = pcall(cjson.decode, body)
      if ok and parsed then
        parsed.model = u.model_override
        req_body = cjson.encode(parsed)
        req_headers["content-length"] = tostring(#req_body)
      end
    end
    -- Always tell downstream transform to preserve the request model.
    -- Router is the authority: either pass-through or explicit override.
    req_headers["x-outgate-model-override"] = "true"
    req_headers["x-outgate-router"] = "${providerSlug}"

    local res, req_err = httpc:request({
      method = method,
      path = upstream_path,
      headers = req_headers,
      body = req_body,
    })

    if res and res.status >= 200 and res.status < 400 then
      kong.log.set_serialize_value("selected_upstream", u.label or u.id)
      local resp_body = res:read_body()
      local resp_headers = {}
      if res.headers then
        for k, v in pairs(res.headers) do
          local lk = k:lower()
          if lk ~= "transfer-encoding" and lk ~= "connection" then
            resp_headers[k] = v
          end
        end
      end
${luaTokenExtraction()}
      kong.response.exit(res.status, resp_body, resp_headers)
      return
    end

    if res then
      last_err = "upstream " .. u.id .. " returned " .. res.status
    else
      last_err = "upstream " .. u.id .. ": " .. (req_err or "request failed")
    end
    httpc:close()
  else
    last_err = "upstream " .. u.id .. ": " .. (conn_err or "connect failed")
  end
  ::continue::
end

kong.response.exit(503, '{"error":"All upstream providers are currently unavailable"}', {
  ["Content-Type"] = "application/json",
})
  `.trim();
}

/**
 * Build the weighted Lua routing script for router providers.
 *
 * Handles:
 * 1. Bearer token extraction (same as failover)
 * 2. Caller API key validation (same as failover)
 * 3. Weighted random upstream selection
 * 4. Single attempt — return upstream response directly (no failover)
 *
 * @param {Array} upstreams - Upstream list [{ providerId, weight }]
 * @param {string} internalApiKey - Internal API key for router→upstream auth
 * @param {string} baseDomain - Region base domain (empty for path-based)
 */
function buildWeightedRoutingScript(upstreams, internalApiKey, baseDomain, routerSlug) {
  const isSubdomain = !!baseDomain;

  const upstreamEntries = upstreams.map((u, i) => {
    const weight = u.weight || 50;
    const modelOverride = u.modelOverride ? `, model_override = "${u.modelOverride.replace(/"/g, '\\"')}"` : '';
    const upstreamLabel = u.modelOverride ? `${u.providerId}:${u.modelOverride}` : u.providerId;
    if (isSubdomain) {
      return `  { id = "${u.providerId}", label = "${upstreamLabel}", host = "${u.providerId}.${baseDomain}", port = 443, protocol = "https", path_prefix = "", weight = ${weight}${modelOverride} }`;
    } else {
      return `  { id = "${u.providerId}", label = "${upstreamLabel}", host = "kong", port = 8000, protocol = "http", path_prefix = "/${u.providerId}", weight = ${weight}${modelOverride} }`;
    }
  });

  return `
-- Router weighted routing script (generated by routerCreate.js)
-- Handles: bearer extract, caller auth, weighted random selection, single attempt

-- 1. Extract caller API key (bearer token or x-api-key header)
local caller_key = kong.request.get_header("x-api-key")
if not caller_key then
  local auth = kong.request.get_header("authorization")
  if auth then
    caller_key = auth:match("^[Bb]earer%s+(.+)$")
  end
end
if not caller_key then
  local apikey = kong.request.get_header("api-key") or kong.request.get_header("api_key")
  if apikey then caller_key = apikey end
end
if not caller_key then
  kong.response.exit(401, '{"error":"Missing API key. Provide x-api-key header or Authorization: Bearer token."}', {
    ["Content-Type"] = "application/json",
  })
  return
end

local http = require "resty.http"

-- 2. Validate caller key via Kong admin API (~1ms localhost call)
local admin = http.new()
admin:set_timeout(5000)
local aok, aerr = admin:connect("kong", 8001)
if aok then
  local ares = admin:request({
    method = "GET",
    path = "/key-auths/" .. caller_key,
    headers = { ["Host"] = "kong" },
  })
  if not ares or ares.status ~= 200 then
    admin:close()
    kong.response.exit(401, '{"error":"Invalid API key"}', {
      ["Content-Type"] = "application/json",
    })
    return
  end
  admin:close()
else
  kong.log.err("Failed to connect to Kong admin for key validation: ", aerr)
end

-- 3. Weighted random upstream selection
local upstreams = {
${upstreamEntries.join(',\n')}
}
local api_key = "${internalApiKey || ''}"

local total_weight = 0
for _, u in ipairs(upstreams) do
  total_weight = total_weight + u.weight
end

local rand = math.random(1, total_weight)
local cumulative = 0
local selected = upstreams[1]
for _, u in ipairs(upstreams) do
  cumulative = cumulative + u.weight
  if rand <= cumulative then
    selected = u
    break
  end
end

-- 4. Single attempt to selected upstream (no failover)
local method = kong.request.get_method()
local path = kong.request.get_path() or "/"
${!isSubdomain ? `-- Strip router prefix for path-based routing
local router_prefix = "/${routerSlug}"
if path:sub(1, #router_prefix) == router_prefix then
  path = path:sub(#router_prefix + 1)
  if path == "" then path = "/" end
end` : ''}
local query = kong.request.get_raw_query()
local body = kong.request.get_raw_body()
if not body then
  ngx.req.read_body()
  body = ngx.req.get_body_data()
end
local headers = kong.request.get_headers()
headers["host"] = nil
headers["x-api-key"] = api_key
headers["accept-encoding"] = "identity"
headers["x-outgate-model-override"] = "true"
headers["x-outgate-router"] = "${providerSlug}"

local httpc = http.new()
httpc:set_timeout(60000)

local ok, conn_err = httpc:connect(selected.host, selected.port)
if not ok then
  kong.response.exit(502, '{"error":"Failed to connect to upstream: ' .. selected.id .. '"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

if selected.protocol == "https" then
  local _, ssl_err = httpc:ssl_handshake(nil, selected.host, false)
  if ssl_err then
    httpc:close()
    kong.response.exit(502, '{"error":"SSL error connecting to upstream: ' .. selected.id .. '"}', {
      ["Content-Type"] = "application/json",
    })
    return
  end
end

local upstream_path = selected.path_prefix .. path
if query and query ~= "" then
  upstream_path = upstream_path .. "?" .. query
end

local req_headers = {}
for k, v in pairs(headers) do
  req_headers[k] = v
end
req_headers["Host"] = selected.host

-- Model override: replace model field in JSON body if configured
local req_body = body
if selected.model_override and body then
  local cjson = require "cjson.safe"
  local ok_json, parsed = pcall(cjson.decode, body)
  if ok_json and parsed then
    parsed.model = selected.model_override
    req_body = cjson.encode(parsed)
    req_headers["content-length"] = tostring(#req_body)
  end
end

local res, req_err = httpc:request({
  method = method,
  path = upstream_path,
  headers = req_headers,
  body = req_body,
})

if not res then
  httpc:close()
  kong.response.exit(502, '{"error":"Request to upstream ' .. selected.id .. ' failed: ' .. (req_err or "unknown") .. '"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

kong.log.set_serialize_value("selected_upstream", selected.label or selected.id)
local resp_body = res:read_body()
local resp_headers = {}
if res.headers then
  for k, v in pairs(res.headers) do
    local lk = k:lower()
    if lk ~= "transfer-encoding" and lk ~= "connection" then
      resp_headers[k] = v
    end
  end
end
${luaTokenExtraction()}
kong.response.exit(res.status, resp_body, resp_headers)
  `.trim();
}

/**
 * Build the smart routing Lua script for AI-powered upstream selection.
 *
 * Handles:
 * 1. Bearer token extraction (same as other types)
 * 2. Caller API key validation (same as other types)
 * 3. Call guardrail /validate with mode=smart_route
 * 4. If BLOCK → return error
 * 5. If ALLOW → store detections in ngx.shared with one-time token, forward to selected upstream
 *
 * @param {Array} upstreams - Upstream list [{ providerId, quality, speed, cost, modelOverride }]
 * @param {string} internalApiKey - Internal API key for router→upstream auth
 * @param {string} baseDomain - Region base domain (empty for path-based)
 * @param {string} routerSlug - Router's own provider slug (for path stripping)
 * @param {string} orgSlug - Organization ID (for guardrail context)
 */
function buildSmartRoutingScript(upstreams, internalApiKey, baseDomain, routerSlug, orgSlug) {
  const isSubdomain = !!baseDomain;

  // Use positional index as upstream ID to support duplicate providers with different model overrides
  const upstreamEntries = upstreams.map((u, i) => {
    const modelOverride = u.modelOverride ? `, model_override = "${u.modelOverride.replace(/"/g, '\\"')}"` : '';
    const upstreamLabel = u.modelOverride ? `${u.providerId}:${u.modelOverride}` : u.providerId;
    if (isSubdomain) {
      return `  { id = "${i}", provider_id = "${u.providerId}", label = "${upstreamLabel}", host = "${u.providerId}.${baseDomain}", port = 443, protocol = "https", path_prefix = "", quality = ${u.quality ?? 5}, speed = ${u.speed ?? 5}, cost = ${u.cost ?? 5}${modelOverride} }`;
    } else {
      return `  { id = "${i}", provider_id = "${u.providerId}", label = "${upstreamLabel}", host = "kong", port = 8000, protocol = "http", path_prefix = "/${u.providerId}", quality = ${u.quality ?? 5}, speed = ${u.speed ?? 5}, cost = ${u.cost ?? 5}${modelOverride} }`;
    }
  });

  // Build JSON array string for upstreams to send to guardrail
  // Include index as id so LLM can select between duplicate providers
  const upstreamsJsonEntries = upstreams.map((u, i) =>
    `'{"id":"${i}","providerId":"${u.providerId}"${u.modelOverride ? ',"modelOverride":"' + u.modelOverride.replace(/"/g, '\\"') + '"' : ''},"quality":${u.quality ?? 5},"speed":${u.speed ?? 5},"cost":${u.cost ?? 5}}'`
  );

  return `
-- Router smart routing script (generated by routerCreate.js)
-- Handles: bearer extract, caller auth, guardrail smart_route call, detection caching, upstream forwarding

local cjson = require "cjson.safe"

-- 1. Extract caller API key (bearer token or x-api-key header)
local caller_key = kong.request.get_header("x-api-key")
if not caller_key then
  local auth = kong.request.get_header("authorization")
  if auth then
    caller_key = auth:match("^[Bb]earer%s+(.+)$")
  end
end
if not caller_key then
  local apikey = kong.request.get_header("api-key") or kong.request.get_header("api_key")
  if apikey then caller_key = apikey end
end
if not caller_key then
  kong.response.exit(401, '{"error":"Missing API key. Provide x-api-key header or Authorization: Bearer token."}', {
    ["Content-Type"] = "application/json",
  })
  return
end

local http = require "resty.http"

-- 2. Validate caller key via Kong admin API (~1ms localhost call)
local admin = http.new()
admin:set_timeout(5000)
local aok, aerr = admin:connect("kong", 8001)
if aok then
  local ares = admin:request({
    method = "GET",
    path = "/key-auths/" .. caller_key,
    headers = { ["Host"] = "kong" },
  })
  if not ares or ares.status ~= 200 then
    admin:close()
    kong.response.exit(401, '{"error":"Invalid API key"}', {
      ["Content-Type"] = "application/json",
    })
    return
  end
  admin:close()
else
  kong.log.err("Failed to connect to Kong admin for key validation: ", aerr)
end

-- 3. Upstream table
local upstreams = {
${upstreamEntries.join(',\n')}
}
local upstreams_by_id = {}
for i, u in ipairs(upstreams) do
  upstreams_by_id[u.id] = u
end
-- Also index by provider_id for backward compatibility with guardrail responses
-- that may return providerId instead of positional index
local upstreams_by_provider = {}
for _, u in ipairs(upstreams) do
  if not upstreams_by_provider[u.provider_id] then
    upstreams_by_provider[u.provider_id] = u
  end
end

local api_key = "${internalApiKey || ''}"

-- 4. Read request details
local method = kong.request.get_method()
local path = kong.request.get_path() or "/"
${!isSubdomain ? `-- Strip router prefix for path-based routing
local router_prefix = "/${routerSlug}"
if path:sub(1, #router_prefix) == router_prefix then
  path = path:sub(#router_prefix + 1)
  if path == "" then path = "/" end
end` : ''}
local query = kong.request.get_raw_query()
local body = kong.request.get_raw_body()
if not body then
  ngx.req.read_body()
  body = ngx.req.get_body_data()
end

-- 5. Call guardrail service with mode=smart_route
local guardrail_url = "${process.env.GUARDRAIL_URL || 'http://guardrail:4002'}"
local guardrail_api_key = "${process.env.INTERNAL_API_KEY || ''}"

local upstreams_json = "[" .. table.concat({${upstreamsJsonEntries.join(', ')}}, ",") .. "]"

local guardrail_body = cjson.encode({
  mode = "smart_route",
  providerId = "${routerSlug}",
  organizationId = "${orgSlug}",
  method = method,
  path = path,
  requestBody = body,
  upstreams = cjson.decode(upstreams_json),
})

local gc = http.new()
gc:set_timeout(60000)
local guardrail_start = ngx.now()
local gres, gerr = gc:request_uri(guardrail_url .. "/validate", {
  method = "POST",
  body = guardrail_body,
  headers = {
    ["Content-Type"] = "application/json",
    ["X-Internal-Api-Key"] = guardrail_api_key,
  },
})
local guardrail_elapsed_ms = math.floor((ngx.now() - guardrail_start) * 1000)
kong.log.set_serialize_value("guardrail_latency_ms", guardrail_elapsed_ms)
kong.log.set_serialize_value("guardrail_validated", true)

if gerr or not gres then
  kong.response.exit(503, '{"error":"Guardrail service unavailable"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

if gres.status ~= 200 then
  kong.log.err("Smart router guardrail error: status=", gres.status, " body=", (gres.body or ""):sub(1, 200))
  kong.response.exit(503, '{"error":"Guardrail service error: ' .. gres.status .. '"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

local gok, gresult = pcall(cjson.decode, gres.body)
if not gok or not gresult then
  kong.response.exit(503, '{"error":"Guardrail service returned invalid response"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

-- 6. Handle BLOCK decision
if gresult.decision == "BLOCK" then
  local status_code = 403
  if gresult.severity == "medium" then
    status_code = 422
  elseif gresult.severity ~= "high" then
    status_code = 400
  end
  kong.response.exit(status_code, cjson.encode({
    error = "Request blocked by security policy",
    reason = gresult.reason or "Content policy violation",
    severity = gresult.severity,
  }), { ["Content-Type"] = "application/json" })
  return
end

-- 7. Select upstream from guardrail response
local selected_id = gresult.selectedUpstream
local selected = upstreams_by_id[selected_id] or upstreams_by_provider[selected_id]
if not selected then
  selected = upstreams[1]
end
kong.log.set_serialize_value("selected_upstream", selected.label)

-- 8. Store detections in ngx.shared for downstream guardrail to skip re-scan
local scan_token = nil
if gresult.detections or gresult.anonymization_map then
  local shared = ngx.shared.request_bodies
  if shared then
    -- Generate random 32-char hex token
    local resty_random = require "resty.random"
    local resty_str = require "resty.string"
    local random_bytes = resty_random.bytes(16)
    if random_bytes then
      scan_token = resty_str.to_hex(random_bytes)
    else
      scan_token = ngx.now() .. "-" .. math.random(100000000, 999999999)
    end

    local cache_data = cjson.encode({
      decision = gresult.decision,
      detections = gresult.detections or {},
      anonymization_map = gresult.anonymization_map,
      severity = gresult.severity,
      reason = gresult.reason,
    })
    shared:set(scan_token, cache_data, 60)  -- 60s TTL
  end
end

-- 9. Forward to selected upstream
local headers = kong.request.get_headers()
headers["host"] = nil
headers["x-api-key"] = api_key
headers["accept-encoding"] = "identity"
headers["x-outgate-model-override"] = "true"
headers["x-outgate-router"] = "${providerSlug}"
if scan_token then
  headers["X-Outgate-Scan-Token"] = scan_token
end

local httpc = http.new()
httpc:set_timeout(60000)

local ok, conn_err = httpc:connect(selected.host, selected.port)
if not ok then
  kong.response.exit(502, '{"error":"Failed to connect to upstream: ' .. selected.id .. '"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

if selected.protocol == "https" then
  local _, ssl_err = httpc:ssl_handshake(nil, selected.host, false)
  if ssl_err then
    httpc:close()
    kong.response.exit(502, '{"error":"SSL error connecting to upstream: ' .. selected.id .. '"}', {
      ["Content-Type"] = "application/json",
    })
    return
  end
end

local upstream_path = selected.path_prefix .. path
if query and query ~= "" then
  upstream_path = upstream_path .. "?" .. query
end

local req_headers = {}
for k, v in pairs(headers) do
  req_headers[k] = v
end
req_headers["Host"] = selected.host

-- Model override: replace model field in JSON body if configured
local req_body = body
if selected.model_override and body then
  local ok_json, parsed = pcall(cjson.decode, body)
  if ok_json and parsed then
    parsed.model = selected.model_override
    req_body = cjson.encode(parsed)
    req_headers["content-length"] = tostring(#req_body)
  end
end

local res, req_err = httpc:request({
  method = method,
  path = upstream_path,
  headers = req_headers,
  body = req_body,
})

if not res then
  httpc:close()
  kong.response.exit(502, '{"error":"Request to upstream ' .. selected.id .. ' failed: ' .. (req_err or "unknown") .. '"}', {
    ["Content-Type"] = "application/json",
  })
  return
end

local resp_body = res:read_body()
local resp_headers = {}
if res.headers then
  for k, v in pairs(res.headers) do
    local lk = k:lower()
    if lk ~= "transfer-encoding" and lk ~= "connection" then
      resp_headers[k] = v
    end
  end
end
${luaTokenExtraction()}
kong.response.exit(res.status, resp_body, resp_headers)
  `.trim();
}
