/**
 * PROVIDER_GUARDRAIL_ENABLE / PROVIDER_GUARDRAIL_DISABLE command handler.
 * Script deployment is now handled by PROVIDER_PREFUNCTION_DEPLOY from the global stack.
 * This handler exists for backward compatibility with older global stack versions.
 */

export async function guardrailToggle(command) {
  const { providerSlug, orgSlug } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;
  const enable = command.type === 'PROVIDER_GUARDRAIL_ENABLE';

  console.log(`[guardrail-toggle] ${enable ? 'Enable' : 'Disable'} received for ${name} (scripts managed by PREFUNCTION_DEPLOY)`);

  return {
    providerId: command.payload.providerId,
    guardrailEnabled: enable,
  };
}
