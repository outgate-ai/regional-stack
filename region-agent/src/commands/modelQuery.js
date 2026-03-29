/**
 * MODEL_QUERY command handler.
 * Returns cached models for a provider from the in-memory store.
 */

import { getModels } from './modelStore.js';

/**
 * Handle MODEL_QUERY command.
 * @param {object} command
 * @param {object} command.payload
 * @param {string} command.payload.providerId
 * @returns {Promise<object>}
 */
export async function modelQuery(command) {
  const { providerId } = command.payload;
  const cached = await getModels(providerId);

  if (!cached) {
    return { models: [], fetchedAt: null, providerType: null };
  }

  return cached;
}
