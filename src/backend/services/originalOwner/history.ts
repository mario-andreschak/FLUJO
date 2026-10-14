import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveOwnerRequest, type OwnerRequestAuthorization } from '@/backend/services/security/ownerAccess';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { getCurrentWorkspace } from '@/utils/workspace';

type HistoryAccess = { authorization: OwnerRequestAuthorization; workspace: string; active: boolean };
const root = globalThis as typeof globalThis & {
  __flujoOriginalOwnerHistoryAccess?: AsyncLocalStorage<HistoryAccess | undefined>;
};
const historyAccess = root.__flujoOriginalOwnerHistoryAccess ??= new AsyncLocalStorage<HistoryAccess | undefined>();

/** A normal Source owner GET may inspect its genuine historical Original run.
 * This scope carries no runtime, model, tool, mutation or Worker authority. */
export async function withOriginalOwnerHistoryAccess<T>(request: Request, task: () => Promise<T>): Promise<T> {
  if (request.method !== 'GET' || isWorkerMode()) return historyAccess.run(undefined, task);
  const resolved = resolveOwnerRequest(request, ['control:admin', 'secrets:read']);
  const workspace = getCurrentWorkspace();
  if (!resolved.ok || resolved.authorization.recheck()
    || (resolved.authorization.principal.workspaceId && resolved.authorization.principal.workspaceId !== workspace)) {
    return historyAccess.run(undefined, task);
  }
  const access: HistoryAccess = { authorization: resolved.authorization, workspace, active: true };
  try { return await historyAccess.run(access, task); }
  finally { access.active = false; }
}

/** Private dispatcher provenance, rather than a saved DTO or bearer alone,
 * binds this read to the current owner's exact conversation and logical run. */
export async function assertOriginalOwnerHistoryAccess(state: unknown, conversationId: string): Promise<boolean> {
  const access = historyAccess.getStore();
  if (!access?.active || isWorkerMode() || access.workspace !== getCurrentWorkspace()
    || access.authorization.recheck() || !state || typeof state !== 'object' || Array.isArray(state)) return false;
  const saved = state as {
    conversationId?: unknown; logicalRunId?: unknown; flowId?: unknown;
    flowSnapshot?: { id?: unknown };
    personaAttribution?: { personaId?: unknown; activityId?: unknown; behaviorRevisionId?: unknown };
  };
  if (saved.conversationId !== conversationId || typeof saved.logicalRunId !== 'string' || !saved.personaAttribution) return false;
  try {
    const { readOriginalOwnerBook } = await import('./store');
    const book = await readOriginalOwnerBook();
    const claims = book.runs?.filter(run => run.workspace === access.workspace
      && run.conversationId === conversationId && run.runId === saved.logicalRunId) ?? [];
    if (claims.length !== 1) return false;
    const run = claims[0], ownerId = access.authorization.principal.ownerId;
    if (run.ownerId !== ownerId || run.personaId !== saved.personaAttribution.personaId
      || run.activityId !== saved.personaAttribution.activityId || run.revisionId !== saved.personaAttribution.behaviorRevisionId
      || (saved.flowId !== undefined && saved.flowId !== run.flowId)
      || (saved.flowSnapshot !== undefined && saved.flowSnapshot?.id !== run.flowId)) return false;
    const enrollment = book.enrollments.find(value => value.id === run.enrollmentId);
    const account = enrollment && book.accounts.find(value => value.id === enrollment.accountId);
    if (!enrollment || !account || enrollment.workspace !== run.workspace || enrollment.ownerId !== ownerId
      || account.ownerId !== ownerId || enrollment.personaId !== run.personaId || enrollment.taskId !== run.taskId
      || enrollment.modelId !== run.modelId || account.modelId !== run.modelId || account.modelDigest !== run.modelDigest) return false;
    // Revoked enrollments/accounts still describe legitimate history. Only the
    // requesting owner's current authorization controls its inspection.
    return access.active && access.workspace === getCurrentWorkspace() && !access.authorization.recheck();
  } catch { return false; }
}
