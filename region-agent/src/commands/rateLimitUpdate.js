/**
 * PROVIDER_RATE_LIMIT_UPDATE command handler.
 * Updates the rate-limiting plugin configuration on a provider's service.
 */

import { getService } from '../kong/service.js';
import { getPlugins, addPlugin, updatePlugin } from '../kong/plugins.js';

const RATE_LIMIT_PLUGIN_NAME = 'rate-limiting';

/**
 * Update rate-limiting configuration for a provider.
 * @param {object} command - The full command object
 * @param {object} command.payload - Rate limit details
 * @param {string} command.payload.orgSlug - Organization slug
 * @param {string} command.payload.providerSlug - Provider slug
 * @param {number} [command.payload.minute] - Requests per minute
 * @param {number} [command.payload.hour] - Requests per hour
 * @param {number} [command.payload.day] - Requests per day
 * @returns {Promise<object>} Update result
 */
export async function rateLimitUpdate(command) {
  const { orgSlug, providerSlug, minute, hour, day } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  console.log(`[rate-limit-update] Updating rate limits for: ${name}`);

  const service = await getService(name);
  const plugins = await getPlugins(service.id);
  const rlPlugin = plugins?.data?.find((p) => p.name === RATE_LIMIT_PLUGIN_NAME);

  const config = {
    minute: minute || undefined,
    hour: hour || undefined,
    day: day || undefined,
    policy: 'local',
  };

  if (rlPlugin) {
    await updatePlugin(rlPlugin.id, config);
    console.log(`[rate-limit-update] Rate limiting plugin updated for ${name}`);
  } else {
    await addPlugin(service.id, RATE_LIMIT_PLUGIN_NAME, config);
    console.log(`[rate-limit-update] Rate limiting plugin created for ${name}`);
  }

  return {
    providerId: command.payload.providerId,
    rateLimit: { minute, hour, day },
  };
}
