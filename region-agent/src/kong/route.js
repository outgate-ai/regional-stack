/**
 * Kong route management.
 * Routes define rules to match client requests to services.
 */

import { get, post, patch, del } from './client.js';

/**
 * Create a route for a service.
 * @param {string} serviceNameOrId - Service name or ID
 * @param {object} opts - Route options (paths, methods, protocols, etc.)
 * @returns {Promise<object>} Created route
 */
export async function createRoute(serviceNameOrId, opts = {}) {
  return post(`/services/${serviceNameOrId}/routes`, opts);
}

/**
 * Update a route by ID.
 * @param {string} routeId - Route ID
 * @param {object} opts - Fields to update
 * @returns {Promise<object>} Updated route
 */
export async function updateRoute(routeId, opts) {
  return patch(`/routes/${routeId}`, opts);
}

/**
 * Delete a route by ID.
 * @param {string} routeId - Route ID
 */
export async function deleteRoute(routeId) {
  return del(`/routes/${routeId}`);
}

/**
 * Get all routes for a service.
 * @param {string} serviceNameOrId - Service name or ID
 * @returns {Promise<object>} Routes list
 */
export async function getRoutesByService(serviceNameOrId) {
  return get(`/services/${serviceNameOrId}/routes`);
}

/**
 * Get a route by ID.
 * @param {string} routeId - Route ID
 * @returns {Promise<object>} Route data
 */
export async function getRoute(routeId) {
  return get(`/routes/${routeId}`);
}
