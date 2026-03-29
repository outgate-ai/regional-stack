/**
 * PROVIDER_ENABLE / PROVIDER_DISABLE command handler.
 * Toggles a provider by adding or removing a request-termination plugin
 * that returns 503 when disabled.
 */

import { getService } from '../kong/service.js';
import { getPlugins, addPlugin, removePlugin } from '../kong/plugins.js';

const DISABLED_PLUGIN_NAME = 'request-termination';

/**
 * Enable or disable a provider in Kong.
 * @param {object} command - The full command object
 * @param {string} command.type - PROVIDER_ENABLE or PROVIDER_DISABLE
 * @param {object} command.payload - Toggle details
 * @param {string} command.payload.orgSlug - Organization slug
 * @param {string} command.payload.providerSlug - Provider slug
 * @returns {Promise<object>} Toggle result
 */
export async function providerToggle(command) {
  const { orgSlug, providerSlug } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;
  const enable = command.type === 'PROVIDER_ENABLE';

  console.log(`[provider-toggle] ${enable ? 'Enabling' : 'Disabling'} provider: ${name}`);

  const service = await getService(name);
  const plugins = await getPlugins(service.id);
  const blockerPlugin = plugins?.data?.find(
    (p) => p.name === DISABLED_PLUGIN_NAME
  );

  if (enable && blockerPlugin) {
    // Remove the termination plugin to re-enable
    await removePlugin(blockerPlugin.id);
    console.log(`[provider-toggle] Provider ${name} enabled`);
  } else if (!enable && !blockerPlugin) {
    // Add a request-termination plugin to block all requests with 503
    await addPlugin(service.id, DISABLED_PLUGIN_NAME, {
      status_code: 503,
      content_type: 'application/json',
      body: JSON.stringify({
        error: 'Service Unavailable',
        message: 'This provider is currently disabled by the gateway administrator.',
      }),
    });
    console.log(`[provider-toggle] Provider ${name} disabled`);
  } else {
    console.log(`[provider-toggle] Provider ${name} already in desired state`);
  }

  return {
    providerId: command.payload.providerId,
    enabled: enable,
  };
}
