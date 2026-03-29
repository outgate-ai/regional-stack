/**
 * ROUTER_UPDATE command handler.
 * Updates Kong resources for a router provider when upstreams change.
 * Deletes and recreates the router (simplest approach for MVP).
 *
 * If internalApiKey is not provided (e.g., script upgrade path),
 * reads the existing raw key from Kong admin API before deleting.
 */

import { providerDelete } from './providerDelete.js';
import { routerCreate } from './routerCreate.js';
import { get as kongGet } from '../kong/client.js';

export async function routerUpdate(command) {
  const { orgSlug, providerSlug, internalApiKeyId } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  console.log(`[router-update] Updating router: ${name}`);

  // If no raw API key provided, read it from Kong before deleting
  if (!command.payload.internalApiKey && internalApiKeyId) {
    try {
      const consumerId = `${orgSlug}-${internalApiKeyId}`;
      const keysData = await kongGet(`/consumers/${consumerId}/key-auth`);
      const keys = keysData?.data || [];
      if (keys.length > 0) {
        command.payload.internalApiKey = keys[0].key;
        console.log(`[router-update] Retrieved existing API key from Kong for ${consumerId}`);
      }
    } catch (err) {
      console.warn(`[router-update] Could not retrieve API key from Kong: ${err.message}`);
    }
  }

  // Delete existing Kong resources
  try {
    await providerDelete({
      payload: { orgSlug, providerSlug, providerId: command.payload.providerId },
    });
  } catch (err) {
    console.log(`[router-update] Delete phase (non-fatal): ${err.message}`);
  }

  // Recreate with new config
  const result = await routerCreate(command);

  console.log(`[router-update] Router ${name} updated`);
  return result;
}
