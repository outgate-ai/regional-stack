/**
 * Kong service management.
 * Services represent upstream APIs that Kong proxies to.
 */

import { get, post, patch, del } from './client.js';

/**
 * Create a service.
 * @param {string} name - Service name
 * @param {object} opts - Service options (host, port, protocol, path, etc.)
 * @returns {Promise<object>} Created service
 */
export async function createService(name, opts = {}) {
  return post('/services', { name, ...opts });
}

/**
 * Update a service by name or ID.
 * @param {string} nameOrId - Service name or ID
 * @param {object} opts - Fields to update
 * @returns {Promise<object>} Updated service
 */
export async function updateService(nameOrId, opts) {
  return patch(`/services/${nameOrId}`, opts);
}

/**
 * Delete a service by name or ID.
 * @param {string} nameOrId - Service name or ID
 */
export async function deleteService(nameOrId) {
  return del(`/services/${nameOrId}`);
}

/**
 * Get a service by name or ID.
 * @param {string} nameOrId - Service name or ID
 * @returns {Promise<object>} Service data
 */
export async function getService(nameOrId) {
  return get(`/services/${nameOrId}`);
}
