import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { continueHumanTask } from './continueHumanTask';
import {
  listHumanTaskEntries,
  pruneHumanTaskEntries,
  syncHumanTaskEntry,
  updateHumanTaskEntry,
  type HumanTaskIndexEntry,
} from './humanTaskIndex';

const log = createLogger('backend/services/humanTasks/humanTaskSweep');

const running = new Set<string>();

export interface HumanTaskSweepReport {
  continued: number;
  repaired: number;
  busy: number;
}

/** Put a list entry right when its conversation no longer waits for that step. */
async function repairEntry(entry: HumanTaskIndexEntry, now: Date): Promise<boolean> {
  const state = await loadConversationState(entry.conversationId).catch(() => undefined);
  if (state?.humanTask?.requestId === entry.requestId) return false;
  const applied = state?.humanTaskLog?.find((record) => record.requestId === entry.requestId);
  await syncHumanTaskEntry(() => updateHumanTaskEntry(entry.requestId, applied
    ? { status: 'applied', outcome: applied.outcome, decisionId: applied.decisionId, decidedAt: applied.decidedAt, finishedAt: now.toISOString() }
    : { status: 'cancelled', finishedAt: now.toISOString() }, now), 'repair');
  return true;
}

/**
 * Look after Human steps without anyone asking (#1095). Runs every minute and once at
 * start-up, for one workspace at a time:
 * - a step past its deadline gets a time-out and its run goes on, by the step's choice;
 * - a saved answer whose run has not gone on yet (FLUJO was busy, or stopped in
 *   between) is picked up again;
 * - list entries that no longer match a waiting step are put right, and old ones go.
 * Steps are handled one after another, so a sweep never floods FLUJO; anything it
 * leaves is picked up by the next one.
 *
 * The minute sweep only opens steps that are due. The start-up sweep (`full`) opens
 * every waiting step once, because FLUJO may have stopped right after an answer was
 * saved and before the list said so.
 */
export async function sweepHumanTasks(
  now: Date = new Date(),
  options: { full?: boolean } = {},
): Promise<HumanTaskSweepReport> {
  const report: HumanTaskSweepReport = { continued: 0, repaired: 0, busy: 0 };
  const workspace = getCurrentWorkspace();
  if (running.has(workspace)) return report;
  if (await isEncryptionLocked()) return report;
  running.add(workspace);
  try {
    for (const entry of await listHumanTaskEntries()) {
      if (entry.status !== 'waiting' && entry.status !== 'decided') continue;
      const due = options.full === true || entry.status === 'decided' || now.getTime() >= Date.parse(entry.expiresAt);
      if (!due) continue;
      try {
        const result = await continueHumanTask(entry.conversationId, { requestId: entry.requestId, expire: true, now });
        if (result.status === 'continued' || result.status === 'dispatched') report.continued += 1;
        else if (result.status === 'busy') report.busy += 1;
        else if (result.status === 'idle' && await repairEntry(entry, now)) report.repaired += 1;
        else if (result.status === 'blocked') log.warn('A Human step cannot go on', { requestId: entry.requestId, reason: result.reason });
      } catch (error) {
        log.warn('Could not continue a Human step; the next sweep tries again', { requestId: entry.requestId, error });
      }
    }
    await pruneHumanTaskEntries(now);
  } finally {
    running.delete(workspace);
  }
  return report;
}
