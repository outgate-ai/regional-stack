/**
 * Kong upstream management.
 * Manages upstreams and their targets for load-balanced routing.
 */

import { get, post, del } from './client.js';
import { getConfig } from '../config.js';

/**
 * Create an upstream with optional healthcheck configuration.
 * @param {string} name - Upstream name
 * @param {object} [opts] - Additional upstream options
 * @returns {Promise<object>} Created upstream
 */
export async function createUpstream(name, opts = {}) {
  return post('/upstreams', { name, ...opts });
}

/**
 * Delete an upstream by name or ID.
 * @param {string} nameOrId - Upstream name or ID
 */
export async function deleteUpstream(nameOrId) {
  return del(`/upstreams/${nameOrId}`);
}

/**
 * Add a target to an upstream.
 * @param {string} upstreamNameOrId - Upstream name or ID
 * @param {string} target - Target address (e.g., api.openai.com:443)
 * @param {number} [weight=100] - Target weight
 * @returns {Promise<object>} Created target
 */
export async function addTarget(upstreamNameOrId, target, weight = getConfig().defaultTargetWeight) {
  return post(`/upstreams/${upstreamNameOrId}/targets`, { target, weight });
}

/**
 * Remove a target from an upstream.
 * @param {string} upstreamNameOrId - Upstream name or ID
 * @param {string} targetId - Target ID
 */
export async function removeTarget(upstreamNameOrId, targetId) {
  return del(`/upstreams/${upstreamNameOrId}/targets/${targetId}`);
}

/**
 * Get an upstream by name or ID.
 * @param {string} nameOrId - Upstream name or ID
 * @returns {Promise<object>} Upstream data
 */
export async function getUpstream(nameOrId) {
  return get(`/upstreams/${nameOrId}`);
}
