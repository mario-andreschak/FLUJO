import { createHash } from 'crypto';

import type {
  PersonaActivity,
  PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';

import { listPersonaRuntimeBundle } from './activityRuntime';
import {
  appendPersonaRuntimeEvent,
  readPersonaRuntimeEvents,
  type PersonaRuntimeEvent,
  type PersonaRuntimeStuckIndicator,
} from './runtimeEvents';
import { listPersonaBundle, type PersonaBundle } from './store';

const log = createLogger('backend/services/enduringAgents/runtimeObservability');

interface StuckObservation {
  indicator: PersonaRuntimeStuckIndicator;
  activityId?: string;
}

export interface SanitizedPersonaRuntimeProjection {
  personaId: string;
  lifecycleState: PersonaBundle['persona']['lifecycleState'];
  mailbox: {
    queued: number;
    ready: number;
    delayed: number;
    claimed: number;
    coalesced: number;
    completed: number;
    rejected: number;
  };
  activities: {
    running: number;
    waiting: number;
    terminal: number;
  };
  active: null | {
    activityId: string;
    kind: PersonaActivity['kind'];
    expiresAt: number;
  };
  waitingActivityIds: string[];
  leaseStatus: 'none' | 'active' | 'released' | 'expired';
  stuck: boolean;
  stuckIndicators: PersonaRuntimeStuckIndicator[];
}

export type SanitizedPersonaRuntimeEvent = Omit<PersonaRuntimeEvent, 'workspaceId'>;

export interface PersonaRuntimeObservation {
  projection: SanitizedPersonaRuntimeProjection;
  detectedStuckIndicators: PersonaRuntimeStuckIndicator[];
  reconciliation: {
    attempted: boolean;
    changed: boolean;
    remainingStuck: boolean;
  };
  recentEvents: SanitizedPersonaRuntimeEvent[];
}

export interface InspectPersonaRuntimeOptions {
  /** Number of newest durable observations to return. Defaults to 50, capped at 200. */
  recentEventLimit?: number;
}

function mailboxForActivity(
  bundle: PersonaBundle,
  activity: PersonaActivity,
): PersonaMailboxItem | undefined {
  return bundle.mailboxItems.find((item) =>
    item.claimedActivityId === activity.id
      || item.idempotencyKey === activity.source.idempotencyKey);
}

function deriveStuckObservations(bundle: PersonaBundle, now: number): StuckObservation[] {
  const observations: StuckObservation[] = [];
  const lease = bundle.lease;
  const activeActivity = lease
    ? bundle.activities.find((activity) => activity.id === lease.activityId)
    : undefined;

  if (lease?.status === 'active') {
    if (lease.expiresAt <= now) {
      observations.push({
        indicator: 'active_lease_expired',
        activityId: activeActivity?.id ?? lease.activityId,
      });
    }
    if (!activeActivity) {
      observations.push({
        indicator: 'active_lease_missing_activity',
        activityId: lease.activityId,
      });
    } else {
      if (
        activeActivity.status === 'completed'
        || activeActivity.status === 'cancelled'
        || activeActivity.status === 'error'
      ) {
        observations.push({ indicator: 'active_activity_terminal', activityId: activeActivity.id });
      } else if (activeActivity.status === 'waiting') {
        observations.push({ indicator: 'active_activity_waiting', activityId: activeActivity.id });
      } else if (activeActivity.status !== 'running') {
        observations.push({ indicator: 'active_activity_not_running', activityId: activeActivity.id });
      }

      const mailbox = mailboxForActivity(bundle, activeActivity);
      if (!mailbox) {
        observations.push({
          indicator: 'active_activity_missing_mailbox',
          activityId: activeActivity.id,
        });
      } else if (mailbox.status !== 'claimed') {
        observations.push({
          indicator: 'active_mailbox_not_claimed',
          activityId: activeActivity.id,
        });
      }
    }
  }

  if (
    bundle.mailboxItems.some((item) => item.status === 'claimed')
    && lease?.status !== 'active'
    && !bundle.activities.some((activity) => activity.status === 'waiting')
  ) {
    observations.push({ indicator: 'claimed_mailbox_without_live_lease' });
  }

  const validActive = lease?.status === 'active'
    && lease.expiresAt > now
    && activeActivity?.status === 'running';
  if (bundle.persona.lifecycleState === 'busy' && !validActive) {
    observations.push({
      indicator: 'lifecycle_projection_mismatch',
      activityId: activeActivity?.id,
    });
  }
  if (
    bundle.persona.lifecycleState === 'waiting'
    && !bundle.activities.some((activity) => activity.status === 'waiting')
  ) {
    observations.push({ indicator: 'waiting_lifecycle_without_waiting_activity' });
  }
  if (bundle.persona.lifecycleState === 'error') {
    observations.push({ indicator: 'lifecycle_error_blocks_work' });
  }

  const deduped = new Map<string, StuckObservation>();
  for (const observation of observations) {
    deduped.set(`${observation.indicator}:${observation.activityId ?? ''}`, observation);
  }
  return [...deduped.values()].sort((left, right) =>
    `${left.indicator}:${left.activityId ?? ''}`.localeCompare(
      `${right.indicator}:${right.activityId ?? ''}`,
    ));
}

function projectBundle(
  bundle: PersonaBundle,
  now: number,
): SanitizedPersonaRuntimeProjection {
  const stuck = deriveStuckObservations(bundle, now);
  const lease = bundle.lease;
  const activeActivity = lease?.status === 'active' && lease.expiresAt > now
    ? bundle.activities.find(
      (activity) => activity.id === lease.activityId && activity.status === 'running',
    )
    : undefined;
  const queued = bundle.mailboxItems.filter((item) => item.status === 'queued');

  return {
    personaId: bundle.persona.id,
    lifecycleState: bundle.persona.lifecycleState,
    mailbox: {
      queued: queued.length,
      ready: queued.filter((item) => (item.notBefore ?? 0) <= now).length,
      delayed: queued.filter((item) => (item.notBefore ?? 0) > now).length,
      claimed: bundle.mailboxItems.filter((item) => item.status === 'claimed').length,
      coalesced: bundle.mailboxItems.filter((item) => item.status === 'coalesced').length,
      completed: bundle.mailboxItems.filter((item) => item.status === 'completed').length,
      rejected: bundle.mailboxItems.filter((item) => item.status === 'rejected').length,
    },
    activities: {
      running: bundle.activities.filter((activity) => activity.status === 'running').length,
      waiting: bundle.activities.filter((activity) => activity.status === 'waiting').length,
      terminal: bundle.activities.filter((activity) =>
        activity.status === 'completed'
          || activity.status === 'cancelled'
          || activity.status === 'error').length,
    },
    active: activeActivity && lease
      ? { activityId: activeActivity.id, kind: activeActivity.kind, expiresAt: lease.expiresAt }
      : null,
    waitingActivityIds: bundle.activities
      .filter((activity) => activity.status === 'waiting')
      .map((activity) => activity.id)
      .sort(),
    leaseStatus: lease?.status ?? 'none',
    stuck: stuck.length > 0,
    stuckIndicators: [...new Set(stuck.map(({ indicator }) => indicator))].sort(),
  };
}

function runtimeFingerprint(bundle: PersonaBundle): string {
  const value = {
    persona: {
      id: bundle.persona.id,
      lifecycleState: bundle.persona.lifecycleState,
      updatedAt: bundle.persona.updatedAt,
    },
    lease: bundle.lease
      ? {
          status: bundle.lease.status,
          activityId: bundle.lease.activityId,
          renewedAt: bundle.lease.renewedAt,
          expiresAt: bundle.lease.expiresAt,
        }
      : null,
    activities: bundle.activities
      .map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    mailboxItems: bundle.mailboxItems
      .map(({ id, status, updatedAt, claimedActivityId }) => ({
        id,
        status,
        updatedAt,
        claimedActivityId: claimedActivityId ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function observationEventId(kind: string, fingerprint: string, suffix?: string): string {
  const tail = suffix
    ? createHash('sha256').update(suffix).digest('hex').slice(0, 12)
    : '';
  return `observe:${kind}:${fingerprint}${tail ? `:${tail}` : ''}`;
}

function sanitizedErrorCode(error: unknown): string {
  const candidate = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error
      ? error.name
      : 'runtime_reconciliation_failed';
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || 'runtime_reconciliation_failed';
}

async function appendObservation(personaId: string, event: unknown): Promise<void> {
  try {
    await appendPersonaRuntimeEvent(personaId, event);
  } catch (error) {
    // Observability failure must not prevent the authoritative runtime from
    // reconciling. The inspection still surfaces the resulting projection.
    log.warn('Failed to append Persona runtime observation.', {
      personaId,
      errorCode: sanitizedErrorCode(error),
    });
  }
}

function sanitizeEvent(event: PersonaRuntimeEvent): SanitizedPersonaRuntimeEvent {
  const { workspaceId: _workspaceId, ...sanitized } = event;
  return sanitized;
}

export interface PersonaRuntimeSnapshot {
  bundle: PersonaBundle;
  runtime: PersonaRuntimeObservation;
}

/**
 * Read the current detail/runtime projection without acquiring a runtime lock
 * or repairing persisted state. Recovery remains an explicit operation.
 */
export async function readPersonaRuntimeSnapshot(
  personaId: string,
  options: InspectPersonaRuntimeOptions = {},
): Promise<PersonaRuntimeSnapshot | null> {
  const bundle = await listPersonaBundle(personaId);
  if (!bundle) return null;

  const projection = projectBundle(bundle, Date.now());
  const requestedLimit = options.recentEventLimit ?? 50;
  const recentLimit = Number.isSafeInteger(requestedLimit)
    ? Math.max(0, Math.min(200, requestedLimit))
    : 50;
  const recentEvents = recentLimit === 0
    ? []
    : await readPersonaRuntimeEvents(personaId, { tail: recentLimit });
  const detectedStuckIndicators = [
    ...new Set(deriveStuckObservations(bundle, Date.now()).map(({ indicator }) => indicator)),
  ].sort();

  return {
    bundle,
    runtime: {
      projection,
      detectedStuckIndicators,
      reconciliation: {
        attempted: false,
        changed: false,
        remainingStuck: projection.stuck,
      },
      recentEvents: recentEvents.map(sanitizeEvent),
    },
  };
}

/**
 * Inspect one Persona through the authoritative lazy-reconciliation boundary.
 *
 * The returned shape deliberately excludes lease id, holder id, fencing token,
 * Behavior payloads, memory, mailbox summaries, and error text.
 */
export async function inspectAndReconcilePersonaRuntime(
  personaId: string,
  options: InspectPersonaRuntimeOptions = {},
): Promise<PersonaRuntimeObservation | null> {
  const before = await listPersonaBundle(personaId);
  if (!before) {
    await listPersonaRuntimeBundle(personaId);
    return null;
  }

  const observedAt = Date.now();
  const beforeStuck = deriveStuckObservations(before, observedAt);
  const beforeFingerprint = runtimeFingerprint(before);
  if (beforeStuck.length > 0) {
    for (const observation of beforeStuck) {
      await appendObservation(personaId, {
        eventId: observationEventId(
          'stuck',
          beforeFingerprint,
          `${observation.indicator}:${observation.activityId ?? ''}`,
        ),
        type: 'stuck:detected',
        indicator: observation.indicator,
        ...(observation.activityId ? { activityId: observation.activityId } : {}),
      });
    }
    await appendObservation(personaId, {
      eventId: observationEventId('recovery-started', beforeFingerprint),
      type: 'recovery:started',
      indicators: [...new Set(beforeStuck.map(({ indicator }) => indicator))].sort(),
    });
  }

  let after: PersonaBundle | null;
  try {
    after = await listPersonaRuntimeBundle(personaId);
  } catch (error) {
    if (beforeStuck.length > 0) {
      await appendObservation(personaId, {
        eventId: observationEventId('recovery-failed', beforeFingerprint),
        type: 'recovery:failed',
        errorCode: sanitizedErrorCode(error),
      });
    }
    throw error;
  }
  if (!after) return null;

  const afterProjection = projectBundle(after, Date.now());
  const changed = runtimeFingerprint(after) !== beforeFingerprint;
  if (beforeStuck.length > 0 && afterProjection.stuck) {
    await appendObservation(personaId, {
      eventId: observationEventId('recovery-failed', beforeFingerprint),
      type: 'recovery:failed',
      errorCode: 'runtime_still_stuck',
    });
  } else if (beforeStuck.length > 0) {
    await appendObservation(personaId, {
      eventId: observationEventId('recovery-completed', beforeFingerprint),
      type: 'recovery:completed',
      changed,
      remainingStuckCount: afterProjection.stuckIndicators.length,
    });
  }

  const requestedLimit = options.recentEventLimit ?? 50;
  const recentLimit = Number.isSafeInteger(requestedLimit)
    ? Math.max(0, Math.min(200, requestedLimit))
    : 50;
  const allEvents = await readPersonaRuntimeEvents(personaId);
  const recentEvents = recentLimit === 0
    ? []
    : allEvents.slice(-recentLimit).map(sanitizeEvent);

  return {
    projection: afterProjection,
    detectedStuckIndicators: [
      ...new Set(beforeStuck.map(({ indicator }) => indicator)),
    ].sort(),
    reconciliation: {
      attempted: beforeStuck.length > 0,
      changed,
      remainingStuck: afterProjection.stuck,
    },
    recentEvents,
  };
}
