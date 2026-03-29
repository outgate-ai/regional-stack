import * as kong from '../kong/client.js';

/**
 * Backfill ACL groups for all existing consumers in an org.
 * Ensures every consumer has the org-wide ACL group so they pass
 * ACL checks on providers that have the ACL plugin enabled.
 */
export async function aclBackfill(command) {
  const { orgSlug } = command.payload;
  const orgGroup = `org-${orgSlug}`;

  // List all consumers whose username starts with the org slug
  let consumers = [];
  let next = `/consumers?size=1000`;
  while (next) {
    const result = await kong.get(next);
    const orgConsumers = (result.data || []).filter(c => c.username?.startsWith(`${orgSlug}-`));
    consumers.push(...orgConsumers);
    next = result.next || null;
  }

  let updated = 0;
  for (const consumer of consumers) {
    try {
      await kong.post(`/consumers/${consumer.id}/acls`, { group: orgGroup });
      updated++;
    } catch (err) {
      // 409 = already has group
      if (err.status !== 409) {
        console.warn(`[acl-backfill] Failed to add group for ${consumer.username}:`, err.message);
      }
    }
  }

  console.log(`[acl-backfill] ${orgSlug}: ${updated}/${consumers.length} consumers updated`);

  return { orgSlug, totalConsumers: consumers.length, updated };
}
