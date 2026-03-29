import { getConfig } from '../config.js';

export async function guardrailPolicySync(command) {
  const config = getConfig();
  const { policyId, organizationId, riskCategories } = command.payload;

  console.log(`[guardrail-policy-sync] Syncing policy ${policyId} for org ${organizationId}`);

  const response = await fetch(`${config.logManagerUrl}/logs/guardrail/policies`, {
    method: 'POST',
    body: JSON.stringify({ policyId, organizationId, riskCategories }),
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.guardrailApiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to sync guardrail policy: ${response.status} ${errorText}`);
  }

  console.log(`[guardrail-policy-sync] Policy ${policyId} synced successfully`);
  return { policyId, synced: true };
}

export async function guardrailPolicyDelete(command) {
  const config = getConfig();
  const { policyId, organizationId } = command.payload;

  console.log(`[guardrail-policy-delete] Deleting policy ${policyId} for org ${organizationId}`);

  const response = await fetch(`${config.logManagerUrl}/logs/guardrail/policies/${organizationId}/${policyId}`, {
    method: 'DELETE',
    headers: {
      'X-Internal-Api-Key': config.guardrailApiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete guardrail policy: ${response.status} ${errorText}`);
  }

  console.log(`[guardrail-policy-delete] Policy ${policyId} deleted successfully`);
  return { policyId, deleted: true };
}
