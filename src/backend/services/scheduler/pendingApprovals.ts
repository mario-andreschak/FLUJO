import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';

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
}

type PendingApprovalsFile = Record<string, PendingApprovalEntry>;

const KEY = StorageKey.PENDING_APPROVALS;

/** Serializes read-modify-write mutations so concurrent pauses/resolves can't
 *  clobber each other's entries. */
let writeChain: Promise<unknown> = Promise.resolve();

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
  const run = writeChain
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(async () => {
      const file = await loadAll();
      file[entry.approvalId] = entry;
      await saveItem(KEY, file);
    });
  writeChain = run;
  await run;
}

export async function removePendingApproval(approvalId: string): Promise<void> {
  const run = writeChain
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(async () => {
      const file = await loadAll();
      if (approvalId in file) {
        delete file[approvalId];
        await saveItem(KEY, file);
      }
    });
  writeChain = run;
  await run;
}
