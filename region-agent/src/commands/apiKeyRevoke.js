/**
 * APIKEY_REVOKE command handler.
 * Deletes a consumer and its key-auth credentials from Kong.
 */

import * as kong from '../kong/client.js';

/**
 * Revoke an API key in Kong by deleting the consumer.
 * @param {object} command - The full command object
 * @param {object} command.payload - Revoke details
 * @param {string} command.payload.consumerId - API key ID (maps to consumer custom_id)
 * @param {string} command.payload.orgSlug - Organization ID/slug (maps to consumer username prefix)
 * @returns {Promise<object>} Revocation result
 */
export async function apiKeyRevoke(command) {
  const { consumerId, orgSlug } = command.payload;
  const username = `${orgSlug}-${consumerId}`;

  console.log(`[apikey-revoke] Revoking consumer: ${username}`);

  try {
    await kong.del(`/consumers/${username}`);
    console.log(`[apikey-revoke] Consumer deleted: ${username}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log(`[apikey-revoke] Consumer ${username} not found, already deleted`);
  }

  return {
    consumerId,
    revoked: true,
  };
}
