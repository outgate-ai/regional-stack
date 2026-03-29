/**
 * ROUTER_DELETE command handler.
 * Removes router Kong resources — same as provider delete since
 * the Kong resource structure is identical (upstream, service, route).
 */

import { providerDelete } from './providerDelete.js';

export async function routerDelete(command) {
  console.log(`[router-delete] Deleting router: ${command.payload.orgSlug}-${command.payload.providerSlug}`);
  return providerDelete(command);
}
