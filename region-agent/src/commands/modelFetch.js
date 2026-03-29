/**
 * MODEL_FETCH command handler + safe model discovery helper.
 * Fetches available models from a provider's API endpoint
 * running inside the region network.
 * Results are stored in Redis via modelStore.
 *
 * Supports two auth modes:
 * - authToken: decrypted token from provider config (used on provider creation)
 * - callerHeaders: raw request headers forwarded from Lua (used on first 200)
 */

import { setModels } from './modelStore.js';

// ============================================================================
// Provider type detection
// ============================================================================

export function detectProviderType(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('openai.com') || urlLower.includes('/v1/')) return 'openai';
  if (urlLower.includes('anthropic.com')) return 'anthropic';
  if (urlLower.includes(':11434') || urlLower.includes('ollama.com') || urlLower.includes('ollama')) return 'ollama';
  return 'custom';
}

// ============================================================================
// URL helpers
// ============================================================================

/**
 * Extract the base URL up to and including /v1 (if present),
 * stripping any path segments after it (e.g. /v1/chat/completions → /v1).
 */
function getBaseUrl(url) {
  const clean = url.replace(/\/+$/, '');
  const v1Index = clean.indexOf('/v1');
  if (v1Index !== -1) return clean.substring(0, v1Index + 3);
  return clean;
}

/**
 * Build the model list URL for a given provider type.
 */
function getModelListUrl(url, providerType) {
  const base = getBaseUrl(url);
  switch (providerType) {
    case 'openai':
    case 'anthropic':
      return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
    case 'ollama':
      return `${base}/api/tags`;
    default:
      return `${base}/models`;
  }
}

// ============================================================================
// Auth headers
// ============================================================================

function buildAuthHeaders(providerType, authToken, callerHeaders) {
  if (callerHeaders) {
    const headers = { ...callerHeaders };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    delete headers['content-type'];
    delete headers['transfer-encoding'];
    headers['content-type'] = 'application/json';
    if (providerType === 'anthropic' && !headers['anthropic-version']) {
      headers['anthropic-version'] = '2023-06-01';
    }
    return headers;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (authToken) {
    if (providerType === 'anthropic') {
      headers['x-api-key'] = authToken;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
  }
  return headers;
}

// ============================================================================
// Per-provider model list parsers
// ============================================================================

function parseOpenAI(data) {
  return (data.data || []).map((m) => ({
    modelId: m.id,
    name: m.id,
    description: m.owned_by ? `Model by ${m.owned_by}` : undefined,
    capabilities: { type: m.object, created: m.created },
    metadata: { permission: m.permission, root: m.root, parent: m.parent },
  }));
}

function parseAnthropic(data) {
  return (data.models || data.data || []).map((m) => ({
    modelId: m.id || m.name,
    name: m.display_name || m.name || m.id,
    description: m.description,
    maxTokens: m.max_input_tokens || m.max_tokens,
    maxOutputTokens: m.max_tokens,
    capabilities: { inputModalities: m.input_modalities, outputModalities: m.output_modalities },
    metadata: m,
  }));
}

function parseOllama(data) {
  return (data.models || []).map((m) => ({
    modelId: m.name,
    name: m.name,
    description: m.details ? `${m.details.family} ${m.details.parameter_size || ''}`.trim() : undefined,
    capabilities: {
      format: m.details?.format, family: m.details?.family,
      parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level,
    },
    metadata: { size: m.size, digest: m.digest, modifiedAt: m.modified_at },
  }));
}

function parseCustom(data) {
  if (data.data && Array.isArray(data.data)) {
    return data.data.map((m) => ({ modelId: m.id || m.name, name: m.id || m.name, metadata: m }));
  }
  if (data.models && Array.isArray(data.models)) {
    return data.models.map((m) => ({ modelId: m.name || m.id, name: m.name || m.id, metadata: m }));
  }
  throw new Error('Unable to parse model response');
}

// ============================================================================
// Core fetch logic
// ============================================================================

async function fetchModelsFromProvider(url, providerType, headers) {
  const fetchUrl = getModelListUrl(url, providerType);
  const fetchHeaders = providerType === 'ollama' ? undefined : headers;

  const res = await fetch(fetchUrl, {
    headers: fetchHeaders,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${providerType} fetch failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  switch (providerType) {
    case 'openai': return parseOpenAI(data);
    case 'anthropic': return parseAnthropic(data);
    case 'ollama': return parseOllama(data);
    default: return parseCustom(data);
  }
}

// ============================================================================
// Safe model discovery (fire-and-forget, never throws)
// ============================================================================

/**
 * Safely fetch and cache models for a provider. Never throws.
 * Use this from providerCreate or any flow where failure should not
 * block the parent operation.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.url - Provider base URL
 * @param {string} [opts.providerType] - Type hint (auto-detected if omitted)
 * @param {string} [opts.authToken] - Stored auth token
 * @param {object} [opts.callerHeaders] - Raw forwarded headers
 */
export async function safeModelDiscovery({ providerId, url, providerType: typeHint, authToken, callerHeaders }) {
  try {
    if (!url) return;
    const providerType = typeHint || detectProviderType(url);
    const headers = buildAuthHeaders(providerType, authToken, callerHeaders);

    console.log(`[model-discovery] Fetching models for ${providerId} from ${url} (type: ${providerType})`);
    const models = await fetchModelsFromProvider(url, providerType, headers);
    console.log(`[model-discovery] ${providerId}: ${models.length} model(s) stored`);

    await setModels(providerId, models, providerType);
  } catch (err) {
    console.error(`[model-discovery] ${providerId}: failed — ${err.message}`);
    // Swallow error — model fetch failure must not affect the parent flow
  }
}

// ============================================================================
// MODEL_FETCH command handler (used by SQS commands + internal endpoint)
// ============================================================================

/**
 * Handle MODEL_FETCH command.
 * @param {object} command
 * @returns {Promise<object>} { models: [...], providerId }
 */
export async function modelFetch(command) {
  const { url, providerType: typeHint, authToken, callerHeaders, providerId } = command.payload;
  const providerType = typeHint || detectProviderType(url);
  const headers = buildAuthHeaders(providerType, authToken, callerHeaders);

  console.log(`[model-fetch] Fetching models from ${url} (type: ${providerType})`, callerHeaders ? `callerHeaders: ${JSON.stringify(Object.keys(callerHeaders))}` : authToken ? 'using authToken' : 'no auth');

  const models = await fetchModelsFromProvider(url, providerType, headers);
  console.log(`[model-fetch] Fetched ${models.length} model(s)`);

  await setModels(providerId, models, providerType);
  return { models, providerId };
}
