/**
 * PROVIDER_PREFUNCTION_DEPLOY command handler.
 * Receives pre-rendered Lua scripts from global stack and deploys them to Kong.
 * Verifies deployment via readback checksum comparison.
 */

import { getService } from '../kong/service.js';
import { getPlugins, getPlugin, addPluginWithTags, updatePluginWithTags, removePlugin } from '../kong/plugins.js';
import { setVersion, computeChecksum, computeLiveChecksums } from '../versionMap.js';

/**
 * Replace region-level placeholders in Lua scripts with local env vars.
 * Global stack renders provider-level vars; region agent fills in the rest.
 */
function resolveRegionVars(scriptArrays) {
  // Parse Redis connection from REDIS_URL (redis://:password@host:port) or separate vars
  let redisHost = process.env.REDIS_HOST || 'redis';
  let redisPort = process.env.REDIS_PORT || '6379';
  let redisPassword = process.env.REDIS_PASSWORD || '';
  if (process.env.REDIS_URL) {
    try {
      const url = new URL(process.env.REDIS_URL);
      redisHost = url.hostname || redisHost;
      redisPort = url.port || redisPort;
      redisPassword = decodeURIComponent(url.password || '') || redisPassword;
    } catch { /* fall back to separate vars */ }
  }

  const regionVars = {
    '{{INTERNAL_API_KEY}}': process.env.INTERNAL_API_KEY || '',
    '{{GUARDRAIL_URL}}': process.env.GUARDRAIL_URL || 'http://guardrail:4002',
    '{{LOG_MANAGER_URL}}': process.env.LOG_MANAGER_URL || 'http://log-manager:4001',
    '{{REDIS_HOST}}': redisHost,
    '{{REDIS_PORT}}': redisPort,
    '{{REDIS_PASSWORD}}': redisPassword,
    '{{REGION_AGENT_PORT}}': process.env.HTTP_PORT || '3100',
  };

  const resolve = (scripts) =>
    scripts.map(script => {
      let result = script;
      for (const [placeholder, value] of Object.entries(regionVars)) {
        result = result.replaceAll(placeholder, value);
      }
      return result;
    });

  return {
    access: resolve(scriptArrays.access || []),
    body_filter: resolve(scriptArrays.body_filter || []),
    header_filter: resolve(scriptArrays.header_filter || []),
  };
}

export async function prefunctionDeploy(command) {
  const { orgSlug, providerSlug, providerId, scripts: rawScripts, version, checksums } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  console.log(`[prefunction-deploy] Deploying v${version} scripts to ${name}`);

  // Resolve region-level placeholders with local env vars
  const scripts = resolveRegionVars(rawScripts);

  const service = await getService(name);
  const plugins = await getPlugins(service.id);
  const preFunction = plugins?.data?.find(p => p.name === 'pre-function');

  // Build config — only include non-empty arrays
  const config = {};
  if (scripts.access?.length) config.access = scripts.access;
  else config.access = [];
  if (scripts.body_filter?.length) config.body_filter = scripts.body_filter;
  else config.body_filter = [];
  if (scripts.header_filter?.length) config.header_filter = scripts.header_filter;
  else config.header_filter = [];

  const hasScripts = config.access.length || config.body_filter.length || config.header_filter.length;

  // Recompute checksums after region-level var replacement
  const localChecksums = {
    access: computeChecksum(config.access),
    body_filter: computeChecksum(config.body_filter),
    header_filter: computeChecksum(config.header_filter),
  };

  const tags = [
    `gw:version=${version}`,
    `gw:cs:access=${localChecksums.access}`,
    `gw:cs:body_filter=${localChecksums.body_filter}`,
    `gw:cs:header_filter=${localChecksums.header_filter}`,
  ];

  let pluginId;

  if (preFunction && hasScripts) {
    await updatePluginWithTags(preFunction.id, config, tags);
    pluginId = preFunction.id;
  } else if (preFunction && !hasScripts) {
    // No scripts needed — remove pre-function plugin entirely
    await removePlugin(preFunction.id);
    pluginId = null;
  } else if (!preFunction && hasScripts) {
    const created = await addPluginWithTags(service.id, 'pre-function', config, tags);
    pluginId = created.id;
  } else {
    // No pre-function and no scripts needed — nothing to do
    pluginId = null;
  }

  // Readback verification
  let integrity = 'ok';
  let liveChecksums = localChecksums;

  if (pluginId) {
    try {
      const deployed = await getPlugin(pluginId);
      liveChecksums = computeLiveChecksums(deployed.config);
      integrity = localChecksums.access === liveChecksums.access
        && localChecksums.body_filter === liveChecksums.body_filter
        && localChecksums.header_filter === liveChecksums.header_filter
        ? 'ok' : 'mismatch';
    } catch (err) {
      console.error(`[prefunction-deploy] Readback failed for ${name}:`, err.message);
      integrity = 'error';
    }
  }

  // Update in-memory version map
  setVersion(providerId, {
    version,
    checksums: liveChecksums,
    deployedAt: new Date().toISOString(),
  });

  console.log(`[prefunction-deploy] ${name} v${version} deployed (integrity: ${integrity})`);

  return {
    providerId,
    version,
    integrity,
    checksums: liveChecksums,
    pluginId,
  };
}
