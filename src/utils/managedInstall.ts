/**
 * Plain settings for an installation that someone else looks after.
 * FLUJO_MANAGED=1 turns both of these off. Each also has its own setting.
 * Read on every use, so a change needs nothing more than the setting itself.
 */
const isOn = (value: string | undefined) => ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
const isOff = (value: string | undefined) => ['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '');

export function isManagedInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOn(env.FLUJO_MANAGED);
}

/** Overrides the in-app switch, which a person using the app could otherwise turn back on. */
export function usageReportingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return isManagedInstall(env) || isOff(env.FLUJO_TELEMETRY);
}

export function updateCheckOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return isManagedInstall(env) || isOff(env.FLUJO_UPDATE_CHECK);
}
