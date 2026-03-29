import * as kong from '../kong/client.js';

export async function apiKeyCreate(command) {
  const { consumerId, apiKeyValue, orgSlug, aclGroups } = command.payload;
  const username = `${orgSlug}-${consumerId}`;

  let consumer;
  try {
    consumer = await kong.post('/consumers', { username, custom_id: username });
  } catch (err) {
    if (err.status === 409) {
      consumer = await kong.get(`/consumers/${username}`);
    } else {
      throw err;
    }
  }

  const credential = await kong.post(`/consumers/${consumer.id}/key-auth`, {
    key: apiKeyValue,
  });

  // Add consumer to ACL groups for service-level access control.
  // Normal keys get the org-wide group; share keys get only specific provider groups.
  const groups = aclGroups || [`org-${orgSlug}`];
  for (const group of groups) {
    try {
      await kong.post(`/consumers/${consumer.id}/acls`, { group });
    } catch (err) {
      // 409 = already in group, safe to ignore
      if (err.status !== 409) throw err;
    }
  }

  console.log(`[apikey-create] ${username} created (acl: ${groups.join(', ')})`);

  return {
    kongConsumerId: consumer.id,
    kongCredentialId: credential.id,
    consumerId,
  };
}
