/**
 * Kong plugin management.
 * Plugins add functionality to services, routes, or consumers.
 */

import { get, post, patch, del } from './client.js';

/**
 * Add a plugin to a service or route.
 * @param {string} entityId - Service or route ID
 * @param {string} pluginName - Plugin name (e.g., key-auth, rate-limiting)
 * @param {object} [config={}] - Plugin configuration
 * @param {string} [scope='service'] - 'service' or 'route'
 * @returns {Promise<object>} Created plugin
 */
export async function addPlugin(entityId, pluginName, config = {}, scope = 'service') {
  const path = scope === 'route'
    ? `/routes/${entityId}/plugins`
    : `/services/${entityId}/plugins`;

  return post(path, { name: pluginName, config });
}

/**
 * Update a plugin by ID.
 * @param {string} pluginId - Plugin ID
 * @param {object} config - Updated plugin configuration
 * @returns {Promise<object>} Updated plugin
 */
export async function updatePlugin(pluginId, config) {
  return patch(`/plugins/${pluginId}`, { config });
}

/**
 * Remove a plugin by ID.
 * @param {string} pluginId - Plugin ID
 */
export async function removePlugin(pluginId) {
  return del(`/plugins/${pluginId}`);
}

/**
 * Get all plugins for a service or route.
 * @param {string} entityId - Service or route ID
 * @param {string} [scope='service'] - 'service' or 'route'
 * @returns {Promise<object>} Plugins list
 */
export async function getPlugins(entityId, scope = 'service') {
  const path = scope === 'route'
    ? `/routes/${entityId}/plugins`
    : `/services/${entityId}/plugins`;

  return get(path);
}

/**
 * Get a single plugin by ID.
 * @param {string} pluginId - Plugin ID
 * @returns {Promise<object>} Plugin object
 */
export async function getPlugin(pluginId) {
  return get(`/plugins/${pluginId}`);
}

/**
 * Add a plugin with tags for version/checksum metadata.
 * @param {string} entityId - Service or route ID
 * @param {string} pluginName - Plugin name
 * @param {object} config - Plugin configuration
 * @param {string[]} tags - Kong tags for metadata
 * @param {string} [scope='service'] - 'service' or 'route'
 * @returns {Promise<object>} Created plugin
 */
export async function addPluginWithTags(entityId, pluginName, config, tags = [], scope = 'service') {
  const path = scope === 'route'
    ? `/routes/${entityId}/plugins`
    : `/services/${entityId}/plugins`;

  return post(path, { name: pluginName, config, tags });
}

/**
 * Update a plugin with tags.
 * @param {string} pluginId - Plugin ID
 * @param {object} config - Updated plugin configuration
 * @param {string[]} tags - Updated tags
 * @returns {Promise<object>} Updated plugin
 */
export async function updatePluginWithTags(pluginId, config, tags) {
  return patch(`/plugins/${pluginId}`, { config, tags });
}
