/**
 * Decides, per workspace, whether Persona history cleanup only measures
 * (`shadow`) or really cleans up (`active`) (#481). Nobody switches it: every
 * workspace starts by measuring, switches cleanup on by itself once its own
 * measurements pass fixed rules, and goes back to measuring by itself on any
 * anomaly. The state is stored in the workspace, so a restart keeps it.
 *
 * Writes need a grant issued here. The grant re-reads the stored state and the
 * Persona lock before every single write, so an anomaly found anywhere stops
 * the next write.
 */

import { z } from 'zod';

import { StorageKey } from '@/shared/types/storage/storage';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import {
  withIssuedPersonaRuntimeLockOperation,
  withWorkspaceRuntimeLock,
  type PersonaRuntimeLock,
} from './runtimeLock';

const log = createLogger('enduringAgents/personaRuntimeRetentionControl');

const DAY_MS = 24 * 60 * 60 * 1_000;
const STATE_LOCK = 'persona-runtime-retention';

/**
 * Cleanup switches on after this many measuring runs in a row found nothing
 * wrong, and only once the first of them is at least this old.
 */
export const PERSONA_RUNTIME_RETENTION_GRADUATION = Object.freeze({
  cleanSweeps: 24,
  spanMs: 7 * DAY_MS,
});

/**
 * A run may change at most `factor` times the largest number of records seen
 * in a clean run since the last anomaly, plus `slack`. More is an anomaly.
 */
export const PERSONA_RUNTIME_RETENTION_VOLUME = Object.freeze({
  factor: 2,
  slack: 100,
});

const ModeSchema = z.enum(['shadow', 'active']);
const AnomalySchema = z.enum(['referenced', 'invalid', 'error', 'volume']);
const count = z.number().int().nonnegative();

const StateSchema = z.object({
  version: z.literal(1),
  mode: ModeSchema,
  /** Measuring runs in a row without an anomaly. */
  cleanSweeps: count,
  /** Clock time of the first run in that streak. */
  streakStartedAt: count.optional(),
  /** Most records any clean run since the last anomaly would change. */
  candidateBaseline: count.optional(),
  graduatedAt: count.optional(),
  rollbacks: count,
  lastAnomaly: z.object({ kind: AnomalySchema, at: count, mode: ModeSchema }).optional(),
  lastSweep: z.object({
    at: count,
    mode: ModeSchema,
    personas: count,
    candidates: count,
    compacted: count,
    anomalies: z.array(AnomalySchema),
  }).optional(),
}).strict();

export type PersonaRuntimeRetentionMode = z.infer<typeof ModeSchema>;
export type PersonaRuntimeRetentionAnomaly = z.infer<typeof AnomalySchema>;
export type PersonaRuntimeRetentionState = z.infer<typeof StateSchema>;
export type PersonaRuntimeRetentionSweepSummary =
  NonNullable<PersonaRuntimeRetentionState['lastSweep']>;
export type PersonaRuntimeRetentionTransition = 'graduated' | 'rolled-back' | null;

export interface PersonaRuntimeRetentionStateRead {
  state: PersonaRuntimeRetentionState;
  /** False when the stored state is briefly unreadable: measure, never write. */
  readable: boolean;
}

export interface PersonaRuntimeRetentionWriteGrant {
  readonly personaId: string;
  /**
   * Re-checks the workspace, the Persona lock and the stored state. False
   * means stop: no further cleanup write may happen under this grant.
   */
  authorize(): Promise<boolean>;
}

const ANOMALY_REASONS: Record<PersonaRuntimeRetentionAnomaly, string> = {
  referenced: 'a record it would change is still used by unfinished work',
  invalid: 'a cleaned-up record would not be valid',
  error: 'a cleanup run hit an error',
  volume: 'a run would change far more records than measured before',
};

const issuedGrants = new WeakSet<object>();

export function initialPersonaRuntimeRetentionState(): PersonaRuntimeRetentionState {
  return { version: 1, mode: 'shadow', cleanSweeps: 0, rollbacks: 0 };
}

/** The most records a run may change before that counts as unusual volume. */
export function personaRuntimeRetentionVolumeBudget(
  state: PersonaRuntimeRetentionState,
): number | null {
  if (state.candidateBaseline === undefined) return null;
  return state.candidateBaseline * PERSONA_RUNTIME_RETENTION_VOLUME.factor
    + PERSONA_RUNTIME_RETENTION_VOLUME.slack;
}

/** Any anomaly means measuring only and a fresh streak with a fresh baseline. */
export function afterPersonaRuntimeRetentionAnomaly(
  state: PersonaRuntimeRetentionState,
  kind: PersonaRuntimeRetentionAnomaly,
  at: number,
): { state: PersonaRuntimeRetentionState; transition: PersonaRuntimeRetentionTransition } {
  const rolledBack = state.mode === 'active';
  return {
    state: {
      ...state,
      mode: 'shadow',
      cleanSweeps: 0,
      streakStartedAt: undefined,
      candidateBaseline: undefined,
      graduatedAt: undefined,
      rollbacks: state.rollbacks + (rolledBack ? 1 : 0),
      lastAnomaly: { kind, at, mode: state.mode },
    },
    transition: rolledBack ? 'rolled-back' : null,
  };
}

/**
 * Record a finished run. A clean measuring run extends the streak; enough of
 * them over enough days switch cleanup on. A run that started in another mode
 * than the state has now raced a change elsewhere and only updates the summary.
 */
export function afterPersonaRuntimeRetentionSweep(
  state: PersonaRuntimeRetentionState,
  sweep: PersonaRuntimeRetentionSweepSummary,
): { state: PersonaRuntimeRetentionState; transition: PersonaRuntimeRetentionTransition } {
  const recorded = { ...state, lastSweep: sweep };
  if (sweep.anomalies.length > 0 || sweep.mode !== state.mode) {
    return { state: recorded, transition: null };
  }
  const candidateBaseline = Math.max(state.candidateBaseline ?? 0, sweep.candidates);
  if (state.mode === 'active') {
    return { state: { ...recorded, candidateBaseline }, transition: null };
  }
  const clockMovedBack = state.streakStartedAt !== undefined && sweep.at < state.streakStartedAt;
  const cleanSweeps = clockMovedBack ? 1 : state.cleanSweeps + 1;
  const streakStartedAt = clockMovedBack ? sweep.at : state.streakStartedAt ?? sweep.at;
  const graduated = cleanSweeps >= PERSONA_RUNTIME_RETENTION_GRADUATION.cleanSweeps
    && sweep.at - streakStartedAt >= PERSONA_RUNTIME_RETENTION_GRADUATION.spanMs;
  return {
    state: {
      ...recorded,
      cleanSweeps,
      streakStartedAt,
      candidateBaseline,
      ...(graduated ? { mode: 'active' as const, graduatedAt: sweep.at } : {}),
    },
    transition: graduated ? 'graduated' : null,
  };
}

/**
 * A stored state whose content is wrong (rather than briefly locked by the
 * system) is rewritten as a fresh measuring state, so it is valid again.
 */
export async function readPersonaRuntimeRetentionState(): Promise<PersonaRuntimeRetentionStateRead> {
  let stored: unknown;
  try {
    stored = await loadItem<unknown>(StorageKey.PERSONA_RUNTIME_RETENTION_STATE, null);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string') {
      return { state: initialPersonaRuntimeRetentionState(), readable: false };
    }
    return { state: await resetUnreadableState(), readable: true };
  }
  if (stored === null) return { state: initialPersonaRuntimeRetentionState(), readable: true };
  const parsed = StateSchema.safeParse(stored);
  if (parsed.success) return { state: parsed.data, readable: true };
  return { state: await resetUnreadableState(), readable: true };
}

async function resetUnreadableState(): Promise<PersonaRuntimeRetentionState> {
  const state = initialPersonaRuntimeRetentionState();
  try {
    await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_STATE, state);
    log.warn('Persona history cleanup state was unreadable; it starts measuring again.');
  } catch (error) {
    log.warn('Persona history cleanup state was unreadable and could not be reset yet.', error);
  }
  return state;
}

/** Read, change and store the state with no other process changing it meanwhile. */
async function updateState(
  change: (state: PersonaRuntimeRetentionState) => {
    state: PersonaRuntimeRetentionState;
    transition: PersonaRuntimeRetentionTransition;
  },
): Promise<{ state: PersonaRuntimeRetentionState; transition: PersonaRuntimeRetentionTransition } | null> {
  return withWorkspaceRuntimeLock(STATE_LOCK, async () => {
    const current = await readPersonaRuntimeRetentionState();
    if (!current.readable) return null;
    const next = change(current.state);
    await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_STATE, next.state);
    return next;
  });
}

/**
 * Go back to measuring at once and start a fresh streak. Logs one plain line
 * when this turns cleanup off, or when it throws away a streak.
 */
export async function recordPersonaRuntimeRetentionAnomaly(
  kind: PersonaRuntimeRetentionAnomaly,
  at: number,
): Promise<void> {
  let lostStreak = 0;
  const next = await updateState((state) => {
    lostStreak = state.cleanSweeps;
    return afterPersonaRuntimeRetentionAnomaly(state, kind, at);
  });
  if (next?.transition === 'rolled-back') {
    log.warn(
      `Persona history cleanup is back to measuring only because ${ANOMALY_REASONS[kind]}. `
      + 'It switches on again by itself after a clean week of measuring.',
    );
  } else if (next && lostStreak > 0) {
    log.info(`Persona history cleanup keeps measuring for another week because ${ANOMALY_REASONS[kind]}.`);
  }
}

export async function recordPersonaRuntimeRetentionSweep(
  sweep: PersonaRuntimeRetentionSweepSummary,
): Promise<PersonaRuntimeRetentionState | null> {
  const next = await updateState((state) => afterPersonaRuntimeRetentionSweep(state, sweep));
  if (next?.transition === 'graduated') {
    const days = Math.floor((sweep.at - (next.state.streakStartedAt ?? sweep.at)) / DAY_MS);
    log.info(
      `Persona history cleanup is now on: ${next.state.cleanSweeps} measuring runs over ${days} days `
      + 'found nothing in use, nothing invalid and no unusual volume.',
    );
  }
  return next?.state ?? null;
}

export async function getPersonaRuntimeRetentionMode(): Promise<PersonaRuntimeRetentionMode> {
  const { state, readable } = await readPersonaRuntimeRetentionState();
  return readable ? state.mode : 'shadow';
}

/**
 * Issue a write grant only while cleanup is `active` and the caller holds this
 * Persona's runtime lock. Returns null otherwise.
 */
export async function acquirePersonaRuntimeRetentionWriteGrant(
  personaId: string,
  lock: PersonaRuntimeLock,
): Promise<PersonaRuntimeRetentionWriteGrant | null> {
  const workspaceId = getCurrentWorkspace();
  const allowed = async () => {
    if (getCurrentWorkspace() !== workspaceId) return false;
    await withIssuedPersonaRuntimeLockOperation(lock, personaId, async () => undefined);
    return await getPersonaRuntimeRetentionMode() === 'active';
  };
  if (!await allowed()) return null;
  const grant: PersonaRuntimeRetentionWriteGrant = Object.freeze({ personaId, authorize: allowed });
  issuedGrants.add(grant);
  return grant;
}

export function assertPersonaRuntimeRetentionWriteGrant(
  grant: PersonaRuntimeRetentionWriteGrant,
  personaId?: string,
): void {
  if (!issuedGrants.has(grant)) {
    throw new Error(
      'Persona history cleanup writes need a grant from acquirePersonaRuntimeRetentionWriteGrant; '
      + 'it checks the stored cleanup state and the Persona lock.',
    );
  }
  if (personaId !== undefined && grant.personaId !== personaId) {
    throw new Error('Persona history cleanup grant belongs to another Persona.');
  }
}
