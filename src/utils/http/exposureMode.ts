/**
 * The single user-facing network exposure setting.
 *
 * `FLUJO_EXPOSURE_MODE` is populated by FLUJO's launcher from the persisted
 * Settings value before Next starts. It is intentionally an implementation
 * detail rather than another operator-facing configuration knob: every server
 * bundle (including the request proxy) can read the same immutable startup
 * value without doing filesystem I/O on each request.
 */

import type { ExposureMode } from '@/shared/types/storage';

export const EXPOSURE_MODES = ['localhost', 'network', 'public'] as const satisfies readonly ExposureMode[];
export type { ExposureMode } from '@/shared/types/storage';

export const DEFAULT_EXPOSURE_MODE: ExposureMode = 'localhost';
export const EXPOSURE_MODE_ENV = 'FLUJO_EXPOSURE_MODE';

export function isExposureMode(value: unknown): value is ExposureMode {
  return typeof value === 'string' && EXPOSURE_MODES.includes(value as ExposureMode);
}

/**
 * Legacy deployment variables are read only as a compatibility migration for
 * installations that have not saved the new Settings value yet. New installs
 * and documentation use the single exposure mode exclusively.
 */
export function inferLegacyExposureMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExposureMode | undefined {
  if (
    env.FLUJO_MCP_APP_SANDBOX_PUBLIC_URL?.trim()
    || env.FLUJO_MCP_APP_HOST_ORIGINS?.trim()
  ) {
    return 'public';
  }
  if (
    env.FLUJO_EXTRA_LOCAL_HOSTS
      ?.split(',')
      .some(entry => entry.trim().length > 0 && entry.trim() !== '.')
  ) return 'network';
  return undefined;
}

export function getExposureMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExposureMode {
  const configured = env[EXPOSURE_MODE_ENV]?.trim().toLowerCase();
  if (isExposureMode(configured)) return configured;
  return inferLegacyExposureMode(env) ?? DEFAULT_EXPOSURE_MODE;
}
