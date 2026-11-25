/**
 * The one place that decides whether Persona runtime retention is off,
 * measuring only (`shadow`) or cleaning up (`active`) for a Persona (#481).
 *
 * Every retention path asks this module: the hourly sweep and the cleanup that
 * follows a finished Activity. Writes need a grant issued here, and the grant
 * re-reads the live switches before every single write, so turning retention
 * off takes effect within seconds and without a restart.
 */

import {
  FEATURES,
  PERSONA_RUNTIME_RETENTION_DEFAULT_CONFIG,
  PERSONA_RUNTIME_RETENTION_DISABLED_CONFIG,
  readPersonaRuntimeRetentionEnvironment,
  validatePersonaRuntimeRetentionConfig,
  type PersonaRuntimeRetentionConfig,
  type PersonaRuntimeRetentionEnvironment,
  type PersonaRuntimeRetentionMode,
} from '@/config/features';
import { StorageKey } from '@/shared/types/storage/storage';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

import {
  getPersonaRetentionEligibility,
  type PersonaRetentionEligibility,
} from './personaRuntimeRetentionCohort';
import {
  withIssuedPersonaRuntimeLockOperation,
  type PersonaRuntimeLock,
} from './runtimeLock';

const log = createLogger('enduringAgents/personaRuntimeRetentionControl');

const SETTING_CACHE_TTL_MS = 5_000;
const UNREADABLE_SETTING_RETRY_MS = 60_000;
const MODE_RANK: Record<PersonaRuntimeRetentionMode, number> = {
  disabled: 0,
  shadow: 1,
  active: 2,
};

export const PERSONA_RUNTIME_RETENTION_MODES: readonly PersonaRuntimeRetentionMode[] =
  ['disabled', 'shadow', 'active'];

export type PersonaRuntimeRetentionModeSource =
  | 'code-switch'
  | 'environment-invalid'
  | 'setting-unreadable'
  | 'setting'
  | 'environment'
  | 'default';

export interface PersonaRuntimeRetentionSetting {
  /** null means no choice was made: the environment or the default decides. */
  mode: PersonaRuntimeRetentionMode | null;
  updatedAt?: number;
}

export interface PersonaRuntimeRetentionControlInputs {
  codeSwitch: boolean;
  environment: PersonaRuntimeRetentionEnvironment;
  setting: PersonaRuntimeRetentionMode | null;
  settingReadable: boolean;
}

export interface PersonaRuntimeRetentionControl {
  /** Effective configuration; `mode` is what retention does right now. */
  config: PersonaRuntimeRetentionConfig;
  /** Which input decided `config.mode`. */
  source: PersonaRuntimeRetentionModeSource;
  defaultMode: PersonaRuntimeRetentionMode;
  codeSwitch: boolean;
  setting: PersonaRuntimeRetentionMode | null;
  environmentMode: PersonaRuntimeRetentionMode | null;
  environmentValid: boolean;
}

export interface PersonaRuntimeRetentionControlOptions {
  /** Replaces the environment for callers that pin a rollout, such as tests. */
  config?: PersonaRuntimeRetentionConfig;
}

export interface PersonaRuntimeRetentionDecision {
  /** What retention may do for this Persona: `disabled` outside the cohort. */
  mode: PersonaRuntimeRetentionMode;
  control: PersonaRuntimeRetentionControl;
  eligibility: PersonaRetentionEligibility | null;
}

export interface PersonaRuntimeRetentionWriteGrant {
  readonly personaId: string;
  readonly cohortVersion: string;
  /**
   * Re-checks lock ownership and the live switches. False means stop: no
   * further retention write may happen under this grant.
   */
  authorize(): Promise<boolean>;
}

type SettingCacheEntry = {
  value: PersonaRuntimeRetentionSetting;
  readable: boolean;
  at: number;
  ttlMs: number;
};

declare global {
  var __flujo_persona_runtime_retention_setting_cache: Map<string, SettingCacheEntry> | undefined;
}

const settingCache: Map<string, SettingCacheEntry> =
  global.__flujo_persona_runtime_retention_setting_cache
  ?? (global.__flujo_persona_runtime_retention_setting_cache = new Map());
const issuedGrants = new WeakSet<object>();
const reportedEnvironmentProblems = new Set<string>();

export function isPersonaRuntimeRetentionMode(
  value: unknown,
): value is PersonaRuntimeRetentionMode {
  return typeof value === 'string'
    && (PERSONA_RUNTIME_RETENTION_MODES as readonly string[]).includes(value);
}

/**
 * Whoever turns retention down wins: the code switch, a malformed environment,
 * an unreadable setting, or the lower of the workspace setting and
 * FLUJO_PERSONA_RUNTIME_RETENTION_MODE. The default applies only when nobody
 * made a choice.
 */
export function resolvePersonaRuntimeRetentionControl(
  inputs: PersonaRuntimeRetentionControlInputs,
): PersonaRuntimeRetentionControl {
  const described = {
    defaultMode: PERSONA_RUNTIME_RETENTION_DEFAULT_CONFIG.mode,
    codeSwitch: inputs.codeSwitch,
    setting: inputs.setting,
    environmentMode: inputs.environment.mode,
    environmentValid: inputs.environment.valid,
  };
  const off = (source: PersonaRuntimeRetentionModeSource): PersonaRuntimeRetentionControl => ({
    ...described,
    config: { ...PERSONA_RUNTIME_RETENTION_DISABLED_CONFIG },
    source,
  });
  if (!inputs.codeSwitch) return off('code-switch');
  if (!inputs.environment.valid) return off('environment-invalid');
  if (!inputs.settingReadable) return off('setting-unreadable');

  const choices: Array<{ mode: PersonaRuntimeRetentionMode; source: PersonaRuntimeRetentionModeSource }> = [];
  if (inputs.setting) choices.push({ mode: inputs.setting, source: 'setting' });
  if (inputs.environment.mode) choices.push({ mode: inputs.environment.mode, source: 'environment' });
  const lowest = choices.reduce<typeof choices[number] | undefined>(
    (current, choice) => (
      current && MODE_RANK[current.mode] <= MODE_RANK[choice.mode] ? current : choice
    ),
    undefined,
  );
  return {
    ...described,
    config: {
      ...inputs.environment.config,
      mode: lowest?.mode ?? described.defaultMode,
    },
    source: lowest?.source ?? 'default',
  };
}

function parseStoredSetting(value: unknown): PersonaRuntimeRetentionSetting | null {
  if (value === null || value === undefined) return { mode: null };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const { mode, updatedAt } = value as Record<string, unknown>;
  if (mode !== null && mode !== undefined && !isPersonaRuntimeRetentionMode(mode)) return null;
  if (updatedAt !== undefined && (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt))) {
    return null;
  }
  return {
    mode: mode ?? null,
    ...(typeof updatedAt === 'number' ? { updatedAt } : {}),
  };
}

function settingCacheKey(): string {
  return workspaceCacheKey('persona-runtime-retention-setting');
}

function remember(entry: Omit<SettingCacheEntry, 'at'>): SettingCacheEntry {
  const stored = { ...entry, at: Date.now() };
  settingCache.set(settingCacheKey(), stored);
  return stored;
}

/**
 * An unreadable switch means off. A file whose content is wrong (rather than
 * briefly locked by the system) is rewritten as off, so it is valid again and
 * is not re-read and re-backed-up every few seconds.
 */
async function healUnreadableSetting(error: unknown): Promise<void> {
  const transient = typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string';
  if (transient) return;
  try {
    await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_SETTINGS, {
      mode: 'disabled',
      updatedAt: Date.now(),
    } satisfies PersonaRuntimeRetentionSetting);
    log.warn('The Persona runtime retention setting was unreadable and has been reset to off.');
  } catch (healError) {
    log.warn('Could not reset the unreadable Persona runtime retention setting.', healError);
  }
}

async function readSetting(): Promise<SettingCacheEntry> {
  const cached = settingCache.get(settingCacheKey());
  if (cached && Date.now() - cached.at < cached.ttlMs) return cached;
  try {
    const parsed = parseStoredSetting(
      await loadItem<unknown>(StorageKey.PERSONA_RUNTIME_RETENTION_SETTINGS, null),
    );
    if (parsed) {
      return remember({ value: parsed, readable: true, ttlMs: SETTING_CACHE_TTL_MS });
    }
    await healUnreadableSetting(new TypeError('Malformed Persona runtime retention setting.'));
  } catch (error) {
    log.warn('Could not read the Persona runtime retention setting; retention stays off.', error);
    await healUnreadableSetting(error);
  }
  return remember({
    value: { mode: null },
    readable: false,
    ttlMs: UNREADABLE_SETTING_RETRY_MS,
  });
}

function readEnvironment(
  options: PersonaRuntimeRetentionControlOptions,
): PersonaRuntimeRetentionEnvironment {
  if (options.config) {
    const config = validatePersonaRuntimeRetentionConfig(options.config);
    return config
      ? { config, mode: config.mode, valid: true }
      : { config: { ...PERSONA_RUNTIME_RETENTION_DISABLED_CONFIG }, mode: null, valid: false };
  }
  const environment = readPersonaRuntimeRetentionEnvironment();
  if (!environment.valid) {
    const problem = JSON.stringify(Object.entries(process.env)
      .filter(([name]) => name.startsWith('FLUJO_PERSONA_RUNTIME_RETENTION_')));
    if (!reportedEnvironmentProblems.has(problem)) {
      reportedEnvironmentProblems.add(problem);
      log.warn(
        'A FLUJO_PERSONA_RUNTIME_RETENTION_* environment variable is malformed; '
        + 'Persona runtime retention stays off until it is corrected.',
      );
    }
  }
  return environment;
}

export async function getPersonaRuntimeRetentionControl(
  options: PersonaRuntimeRetentionControlOptions = {},
): Promise<PersonaRuntimeRetentionControl> {
  const codeSwitch = FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION;
  const environment = readEnvironment(options);
  const settingCannotRaise = !codeSwitch || !environment.valid || environment.mode === 'disabled';
  const setting = settingCannotRaise
    ? { value: { mode: null }, readable: true }
    : await readSetting();
  return resolvePersonaRuntimeRetentionControl({
    codeSwitch,
    environment,
    setting: setting.value.mode,
    settingReadable: setting.readable,
  });
}

export async function getPersonaRuntimeRetentionSetting(): Promise<PersonaRuntimeRetentionSetting> {
  return (await readSetting()).value;
}

/** Store the workspace choice; it applies to the next write in this process at once. */
export async function setPersonaRuntimeRetentionSetting(
  mode: PersonaRuntimeRetentionMode | null,
): Promise<PersonaRuntimeRetentionSetting> {
  if (mode !== null && !isPersonaRuntimeRetentionMode(mode)) {
    throw new TypeError('Persona runtime retention mode must be disabled, shadow, active or null.');
  }
  const value: PersonaRuntimeRetentionSetting = { mode, updatedAt: Date.now() };
  await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_SETTINGS, value);
  remember({ value, readable: true, ttlMs: SETTING_CACHE_TTL_MS });
  log.info(`Persona runtime retention setting changed to ${mode ?? 'default'}.`);
  return value;
}

export function decidePersonaRuntimeRetention(
  control: PersonaRuntimeRetentionControl,
  workspaceId: string,
  personaId: string,
): PersonaRuntimeRetentionDecision {
  if (control.config.mode === 'disabled' || control.config.rolloutBasisPoints === 0) {
    return { mode: 'disabled', control, eligibility: null };
  }
  const eligibility = getPersonaRetentionEligibility({
    workspaceId,
    personaId,
    cohortVersion: control.config.cohortVersion,
    rolloutBasisPoints: control.config.rolloutBasisPoints,
    criticalPersonaIds: control.config.criticalPersonaIds,
  });
  return {
    mode: eligibility.eligible ? control.config.mode : 'disabled',
    control,
    eligibility,
  };
}

export async function getPersonaRuntimeRetentionDecision(
  personaId: string,
  options: PersonaRuntimeRetentionControlOptions = {},
): Promise<PersonaRuntimeRetentionDecision> {
  return decidePersonaRuntimeRetention(
    await getPersonaRuntimeRetentionControl(options),
    getCurrentWorkspace(),
    personaId,
  );
}

/**
 * Issue a write grant only when retention is `active` for this Persona and the
 * caller holds this Persona's runtime lock. Returns null otherwise.
 */
export async function acquirePersonaRuntimeRetentionWriteGrant(
  personaId: string,
  lock: PersonaRuntimeLock,
  options: PersonaRuntimeRetentionControlOptions & { cohortVersion?: string } = {},
): Promise<PersonaRuntimeRetentionWriteGrant | null> {
  await withIssuedPersonaRuntimeLockOperation(lock, personaId, async () => undefined);
  const decision = await getPersonaRuntimeRetentionDecision(personaId, options);
  const cohortVersion = decision.control.config.cohortVersion;
  if (
    decision.mode !== 'active'
    || (options.cohortVersion !== undefined && options.cohortVersion !== cohortVersion)
  ) {
    return null;
  }
  const workspaceId = getCurrentWorkspace();
  const grant: PersonaRuntimeRetentionWriteGrant = Object.freeze({
    personaId,
    cohortVersion,
    authorize: async () => {
      if (getCurrentWorkspace() !== workspaceId) return false;
      await withIssuedPersonaRuntimeLockOperation(lock, personaId, async () => undefined);
      const live = await getPersonaRuntimeRetentionDecision(personaId, options);
      return live.mode === 'active' && live.control.config.cohortVersion === cohortVersion;
    },
  });
  issuedGrants.add(grant);
  return grant;
}

export function assertPersonaRuntimeRetentionWriteGrant(
  grant: PersonaRuntimeRetentionWriteGrant,
  personaId?: string,
): void {
  if (!issuedGrants.has(grant)) {
    throw new Error(
      'Persona runtime retention writes need a grant from '
      + 'acquirePersonaRuntimeRetentionWriteGrant; it checks the live switches and the cohort.',
    );
  }
  if (personaId !== undefined && grant.personaId !== personaId) {
    throw new Error('Persona runtime retention grant belongs to another Persona.');
  }
}
