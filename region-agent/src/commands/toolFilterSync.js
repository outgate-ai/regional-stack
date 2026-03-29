/**
 * PROVIDER_TOOL_FILTER_SYNC command handler.
 * Script deployment is now handled by PROVIDER_PREFUNCTION_DEPLOY from the global stack.
 * This handler exists for backward compatibility with older global stack versions.
 */

export async function toolFilterSync(command) {
  const { orgSlug, providerSlug } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;

  console.log(`[tool-filter-sync] Received for ${name} (scripts managed by PREFUNCTION_DEPLOY)`);

  return { providerId: command.payload.providerId };
}
