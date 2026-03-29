/**
 * PROVIDER_DELETE command handler.
 * Removes a provider from Kong in reverse dependency order:
 * route -> service -> upstream.
 */

import { deleteUpstream } from '../kong/upstream.js';
import { deleteService, getService } from '../kong/service.js';
import { getRoutesByService, deleteRoute } from '../kong/route.js';

/**
 * Delete a provider from Kong.
 * @param {object} command - The full command object
 * @param {object} command.payload - Delete details
 * @param {string} command.payload.orgSlug - Organization slug
 * @param {string} command.payload.providerSlug - Provider slug
 * @returns {Promise<object>} Deletion result
 */
export async function providerDelete(command) {
  const { orgSlug, providerSlug } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  console.log(`[provider-delete] Deleting provider: ${name}`);

  // 1. Delete all routes for the service
  try {
    const routes = await getRoutesByService(name);
    for (const route of routes?.data || []) {
      await deleteRoute(route.id);
      console.log(`[provider-delete] Route deleted: ${route.id}`);
    }
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log(`[provider-delete] No routes found for service ${name}`);
  }

  // 2. Delete service
  try {
    await deleteService(name);
    console.log(`[provider-delete] Service deleted: ${name}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log(`[provider-delete] Service ${name} not found, skipping`);
  }

  // 3. Delete upstream
  try {
    await deleteUpstream(name);
    console.log(`[provider-delete] Upstream deleted: ${name}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log(`[provider-delete] Upstream ${name} not found, skipping`);
  }

  console.log(`[provider-delete] Provider ${name} fully deleted`);

  return { providerId: command.payload.providerId, deleted: true };
}
