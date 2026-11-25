/**
 * Durable, numbers-only record of recent Persona runtime retention sweeps
 * (#481). Logs are off by default in FLUJO, so this report is what shows what
 * measuring (`shadow`) and cleanup (`active`) actually did on real data.
 *
 * It holds counts, sizes and timings only: no Persona ids, payloads,
 * idempotency keys, digests or error text.
 */

import { z } from 'zod';

import { StorageKey } from '@/shared/types/storage/storage';
import { createLogger } from '@/utils/logger';
import { loadItem, runInWriteChain, saveItem } from '@/utils/storage/backend';
import { workspaceCacheKey } from '@/utils/workspace';

import type {
  PersonaRuntimeRetentionCollectionTotals,
  PersonaRuntimeRetentionSweepResult,
} from './personaRuntimeRetentionRollout';

const log = createLogger('enduringAgents/personaRuntimeRetentionReports');

/** One week of hourly sweeps. Older reports roll off; totals keep counting. */
export const PERSONA_RUNTIME_RETENTION_REPORT_LIMIT = 168;

const count = z.number().int().nonnegative();
const ModeSchema = z.enum(['disabled', 'shadow', 'active']);

const CollectionReportSchema = z.object({
  scanned: count,
  candidateCount: count,
  selected: count,
  compacted: count,
  skipped: count,
  failed: count,
  unauthorized: count,
  remaining: count,
  bytesBefore: count,
  projectedBytesAfter: count,
});

const SweepReportSchema = z.object({
  sweepId: z.string().min(1),
  mode: ModeSchema,
  modeSource: z.string().min(1),
  cohortVersion: z.string().min(1),
  rolloutBasisPoints: count,
  startedAt: count,
  durationMs: count,
  personasExamined: count,
  personasSelected: count,
  personasSkipped: count,
  personasFailed: count,
  maxLockWaitMs: count,
  maxLockHeldMs: count,
  collections: z.object({
    mailboxItems: CollectionReportSchema,
    activities: CollectionReportSchema,
    flowDispatches: CollectionReportSchema,
    behaviorCallPins: CollectionReportSchema,
  }),
});

const TotalsSchema = z.object({
  sweeps: count,
  shadowSweeps: count,
  activeSweeps: count,
  firstSweepAt: count.optional(),
  lastSweepAt: count.optional(),
  personasFailed: count,
  compacted: count,
  failed: count,
  maxLockHeldMs: count,
});

const ReportsSchema = z.object({
  recent: z.array(SweepReportSchema),
  totals: TotalsSchema,
});

export type PersonaRuntimeRetentionCollectionReport = z.infer<typeof CollectionReportSchema>;
export type PersonaRuntimeRetentionSweepReport = z.infer<typeof SweepReportSchema>;
export type PersonaRuntimeRetentionReportTotals = z.infer<typeof TotalsSchema>;
export type PersonaRuntimeRetentionReports = z.infer<typeof ReportsSchema>;

function emptyReports(): PersonaRuntimeRetentionReports {
  return {
    recent: [],
    totals: {
      sweeps: 0,
      shadowSweeps: 0,
      activeSweeps: 0,
      personasFailed: 0,
      compacted: 0,
      failed: 0,
      maxLockHeldMs: 0,
    },
  };
}

function collectionReport(
  totals: PersonaRuntimeRetentionCollectionTotals,
): PersonaRuntimeRetentionCollectionReport {
  return {
    scanned: totals.scanned,
    candidateCount: totals.candidateCount,
    selected: totals.selected,
    compacted: totals.compacted,
    skipped: totals.skipped,
    failed: totals.failed,
    unauthorized: totals.unauthorized,
    remaining: totals.remaining,
    bytesBefore: totals.bytesBefore,
    projectedBytesAfter: totals.projectedBytesAfter,
  };
}

function toReport(result: PersonaRuntimeRetentionSweepResult): PersonaRuntimeRetentionSweepReport {
  const collections = {
    mailboxItems: collectionReport(result.collections.mailboxItems),
    activities: collectionReport(result.collections.activities),
    flowDispatches: collectionReport(result.collections.flowDispatches),
    behaviorCallPins: collectionReport(result.collections.behaviorCallPins),
  };
  return {
    sweepId: result.sweepId,
    mode: result.mode,
    modeSource: result.modeSource,
    cohortVersion: result.cohortVersion,
    rolloutBasisPoints: result.rolloutBasisPoints,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    personasExamined: result.personasExamined,
    personasSelected: result.personasSelected,
    personasSkipped: result.personasSkipped,
    personasFailed: result.personasFailed,
    maxLockWaitMs: result.maxLockWaitMs,
    maxLockHeldMs: result.maxLockHeldMs,
    collections,
  };
}

async function loadReports(): Promise<PersonaRuntimeRetentionReports | null> {
  let stored: unknown;
  try {
    stored = await loadItem<unknown>(StorageKey.PERSONA_RUNTIME_RETENTION_REPORTS, null);
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') return null;
    log.warn('Persona runtime retention reports were unreadable; starting a new report.');
    return emptyReports();
  }
  if (stored === null) return emptyReports();
  const parsed = ReportsSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  log.warn('Persona runtime retention reports had an unexpected shape; starting a new report.');
  return emptyReports();
}

/**
 * Append one sweep. A report file that cannot be read because the system has
 * it locked is left alone and this sweep is skipped; a damaged one is replaced.
 */
export async function recordPersonaRuntimeRetentionSweep(
  result: PersonaRuntimeRetentionSweepResult,
): Promise<void> {
  await runInWriteChain(workspaceCacheKey('persona-runtime-retention-reports'), async () => {
    const reports = await loadReports();
    if (!reports) {
      log.warn('Persona runtime retention reports are busy; this sweep was not recorded.');
      return;
    }
    const report = toReport(result);
    const compacted = Object.values(report.collections)
      .reduce((total, collection) => total + collection.compacted, 0);
    const failed = Object.values(report.collections)
      .reduce((total, collection) => total + collection.failed, 0);
    const totals = reports.totals;
    await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_REPORTS, {
      recent: [report, ...reports.recent].slice(0, PERSONA_RUNTIME_RETENTION_REPORT_LIMIT),
      totals: {
        sweeps: totals.sweeps + 1,
        shadowSweeps: totals.shadowSweeps + (report.mode === 'shadow' ? 1 : 0),
        activeSweeps: totals.activeSweeps + (report.mode === 'active' ? 1 : 0),
        firstSweepAt: totals.firstSweepAt ?? report.startedAt,
        lastSweepAt: report.startedAt,
        personasFailed: totals.personasFailed + report.personasFailed,
        compacted: totals.compacted + compacted,
        failed: totals.failed + failed,
        maxLockHeldMs: Math.max(totals.maxLockHeldMs, report.maxLockHeldMs),
      },
    } satisfies PersonaRuntimeRetentionReports);
  });
}

/** Newest first. Read-only; an unreadable report reads as empty. */
export async function getPersonaRuntimeRetentionReports(): Promise<PersonaRuntimeRetentionReports> {
  return await loadReports() ?? emptyReports();
}
