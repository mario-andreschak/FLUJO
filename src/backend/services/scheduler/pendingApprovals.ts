import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { bindToCurrentWorkspace, getCurrentWorkspace } from '@/utils/workspace';
import type { TriggerFirePayload } from '@/shared/types/plannedExecution';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';

const log = createLogger('backend/services/scheduler/pendingApprovals');

/**
 * Durable approval inbox (issue #115).
 *
 * When a HEADLESS (scheduled) run pauses on a tool that needs approval
 * (approvalPolicy 'pause'), the scheduler records a metadata-only entry here so
 * GET /api/approvals can list the paused run WITHOUT scanning every
 * conversation, and POST /api/approvals/:id can find + reconcile it after a
 * process restart. Cleared once the approval is resolved.
 *
 * The store is a single JSON object keyed by approvalId (== the run's
 * conversationId) at db/pending_approvals.json. It carries ONLY metadata (ids,
 * flow, tool NAMES, timestamps) — never prompt text, messages, tool arguments
 * or any decrypted binding. The actual paused SharedState (with the real tool
 * calls) lives in the conversations/* store and is the source of truth for the
 * resume; this index just makes the paused run discoverable.
 */
export interface PendingApprovalEntry {
  /** Stable id for the approval — equal to the run's conversationId. */
  approvalId: string;
  conversationId: string;
  plannedExecutionId: string;
  flowId: string;
  flowName?: string;
  /** The run history record id this approval belongs to (for reconciliation). */
  runId: string;
  triggerSummary: string;
  /** Tool call id + name only — never arguments. */
  pendingToolCalls: Array<{ id: string; name: string }>;
  createdAt: string;
  /** Durable marker that an approval decision already resumed this Activity. */
  resumeDispatchId?: string;
  resumeRequestedAt?: string;
  /**
   * Stable scheduler terminal-publication identity retained across an approval
   * yield. Present only for Persona deliveries admitted through the mailbox.
   */
  terminalPublication?: {
    triggerKind: TriggerFirePayload['kind'];
    chainDepth: number;
    deliveryId: string;
    execution: {
      id: string;
      generationId?: string;
      name: string;
      flowId: string;
      personaId: string;
    };
  };
}

type PendingApprovalsFile = Record<string, PendingApprovalEntry>;

const KEY = StorageKey.PENDING_APPROVALS;
const LOCK_ID = 'scheduler_pending_approvals';

/** Serializes read-modify-write mutations so concurrent pauses/resolves can't
 *  clobber each other's entries. */
const writeChains = new Map<string, Promise<unknown>>();

async function loadAll(): Promise<PendingApprovalsFile> {
  try {
    const file = await loadItem<PendingApprovalsFile>(KEY, {});
    return file && typeof file === 'object' ? file : {};
  } catch (error) {
    log.error('Failed to load pending approvals:', error);
    return {};
  }
}

export async function listPendingApprovals(): Promise<PendingApprovalEntry[]> {
  const file = await loadAll();
  return Object.values(file).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getPendingApproval(
  approvalId: string
): Promise<PendingApprovalEntry | null> {
  const file = await loadAll();
  return file[approvalId] ?? null;
}

export async function putPendingApproval(entry: PendingApprovalEntry): Promise<void> {
  const workspace = getCurrentWorkspace();
  const write = bindToCurrentWorkspace(async () => {
    await withPersonaRuntimeLock(LOCK_ID, async (lock) => {
      const file = await loadAll();
      const existing = file[entry.approvalId];
      if (
        existing
        && (
          existing.conversationId !== entry.conversationId
          || existing.plannedExecutionId !== entry.plannedExecutionId
          || existing.runId !== entry.runId
        )
      ) {
        throw new Error(`Pending approval ${entry.approvalId} conflicts with another run.`);
      }
      file[entry.approvalId] = entry;
      await lock.assertOwned();
      await saveItem(KEY, file);
    });
  });
  const run = (writeChains.get(workspace) ?? Promise.resolve())
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(write);
  writeChains.set(workspace, run);
  try {
    await run;
  } finally {
    if (writeChains.get(workspace) === run) writeChains.delete(workspace);
  }
}

export async function removePendingApproval(approvalId: string): Promise<void> {
  const workspace = getCurrentWorkspace();
  const write = bindToCurrentWorkspace(async () => {
    await withPersonaRuntimeLock(LOCK_ID, async (lock) => {
      const file = await loadAll();
      if (approvalId in file) {
        delete file[approvalId];
        await lock.assertOwned();
        await saveItem(KEY, file);
      }
    });
  });
  const run = (writeChains.get(workspace) ?? Promise.resolve())
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(write);
  writeChains.set(workspace, run);
  try {
    await run;
  } finally {
    if (writeChains.get(workspace) === run) writeChains.delete(workspace);
  }
}

/** Remove resumable approval intents that explicitly target a deleted Persona. */
export async function removePendingApprovalsForPersonaId(personaId: string): Promise<number> {
  EnduringAgentIdSchema.parse(personaId);
  const workspace = getCurrentWorkspace();
  let removed = 0;
  const write = bindToCurrentWorkspace(async () => {
    await withPersonaRuntimeLock(LOCK_ID, async (lock) => {
      const file = await loadAll();
      for (const [approvalId, entry] of Object.entries(file)) {
        if (entry.terminalPublication?.execution.personaId !== personaId) continue;
        delete file[approvalId];
        removed += 1;
      }
      if (removed === 0) return;
      await lock.assertOwned();
      await saveItem(KEY, file);
    });
  });
  const run = (writeChains.get(workspace) ?? Promise.resolve())
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(write);
  writeChains.set(workspace, run);
  try {
    await run;
  } finally {
    if (writeChains.get(workspace) === run) writeChains.delete(workspace);
  }
  return removed;
}
