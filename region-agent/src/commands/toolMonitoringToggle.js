/**
 * PROVIDER_TOOL_MONITORING_TOGGLE command handler.
 * Script deployment is now handled by PROVIDER_PREFUNCTION_DEPLOY from the global stack.
 * This handler exists for backward compatibility with older global stack versions.
 */

export async function toolMonitoringToggle(command) {
  const { orgSlug, providerSlug, toolMonitoring } = command.payload;
  const name = `${orgSlug}-${providerSlug}`;
  const enable = toolMonitoring === true;

  console.log(`[tool-monitoring] ${enable ? 'Enable' : 'Disable'} received for ${name} (scripts managed by PREFUNCTION_DEPLOY)`);

  return {
    providerId: command.payload.providerId,
    toolMonitoring: enable,
  };
}
