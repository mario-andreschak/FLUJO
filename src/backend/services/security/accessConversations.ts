import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getCurrentWorkspace, getWorkspaceDataDir } from '../../../utils/workspace';
import { assertSafeCollectionId } from '../../../utils/storage/backend';
import { FlowExecutor } from '../../execution/flow/FlowExecutor';
import { loadConversationState } from '../../execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '../../execution/flow/personaConversationOwnership';
import type { SharedState } from '../../execution/flow/types';
import { getPendingApproval } from '../scheduler/pendingApprovals';
import { recordAccessEvent } from './accessAudit';
import type { AccessActor } from './accessContext';
import { accessRouteParameter, type AccessRouteRule } from './accessRoutes';

/**
 * Who may see which conversation, when named access is on.
 *
 * Kept apart from the wrapper every route imports, because this one pulls in the
 * execution engine. It is only loaded for a narrow credential on a checked route.
 */

interface ConversationOwnership {
  readonly exists: boolean;
  readonly ownerId?: string;
  readonly personaOwned?: boolean;
}

function ownershipOfState(state: SharedState): ConversationOwnership {
  return {
    exists: true,
    ...(state.accessOwner?.credentialId ? { ownerId: state.accessOwner.credentialId } : {}),
    personaOwned: isPersonaOwnedConversationState(state),
  };
}

/** The small summary beside the conversation saves reading its whole history on every request. */
async function ownershipFromSummary(id: string): Promise<ConversationOwnership | null> {
  try {
    const summary = JSON.parse(await fs.readFile(
      path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8',
    )) as { accessOwnerId?: unknown; personaOwned?: unknown };
    // Only a positive record answers here. A summary with no owner may simply
    // predate the owner, so the conversation itself has the last word.
    if (typeof summary.accessOwnerId !== 'string') return null;
    return { exists: true, ownerId: summary.accessOwnerId, personaOwned: summary.personaOwned === true };
  } catch {
    return null;
  }
}

export async function lookupConversationOwnership(id: string): Promise<ConversationOwnership> {
  try { assertSafeCollectionId(id); } catch { return { exists: false }; }
  const live = FlowExecutor.conversationStates.get(id);
  if (live) return ownershipOfState(live);
  const summary = await ownershipFromSummary(id);
  if (summary) return summary;
  try {
    const state = await loadConversationState(id);
    return state ? ownershipOfState(state) : { exists: false };
  } catch {
    // Unreadable means not provably yours. Refuse, and let the caller retry.
    return { exists: true };
  }
}

export function actorMayAccess(actor: AccessActor, ownership: ConversationOwnership): boolean {
  if (actor.isAdmin) return true;
  if (!ownership.exists || ownership.personaOwned) return false;
  return actor.seesAll || ownership.ownerId === actor.credentialId;
}

export function stateVisibleToActor(actor: AccessActor, state: SharedState | undefined): boolean {
  if (actor.isAdmin) return true;
  return Boolean(state) && actorMayAccess(actor, ownershipOfState(state!));
}

/** Same rule for the small list rows the sidebar and API listings work from. */
export function summaryVisibleToActor(actor: AccessActor, summary: {
  accessOwnerId?: string; personaOwned?: true;
}): boolean {
  if (actor.isAdmin) return true;
  if (summary.personaOwned) return false;
  return actor.seesAll || summary.accessOwnerId === actor.credentialId;
}

/** One answer for "not yours" and "does not exist", so an id cannot be probed. */
export function conversationNotFound(): Response {
  return Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The row check for a path that names a conversation or an approval. It runs in
 * the workspace wrapper, before the handler reads anything, so it covers listing,
 * reading, deleting, streaming, resources and approvals in one place.
 */
export async function enforceRowAccess(actor: AccessActor, rule: AccessRouteRule, pathname: string): Promise<Response | null> {
  if (actor.isAdmin) return null;
  const id = accessRouteParameter(rule, pathname);
  if (id === null) return conversationNotFound();
  let conversationId = id;
  if (rule.row === 'approval') {
    // The inbox id equals the conversation id today. Prefer the durable receipt
    // so that stays true even if an entry ever names its conversation separately.
    const entry = await getPendingApproval(id).catch(() => undefined);
    conversationId = entry?.conversationId ?? id;
  }
  if (actorMayAccess(actor, await lookupConversationOwnership(conversationId))) return null;
  recordAccessEvent({ action: 'access.denied', outcome: 'denied', actor, target: conversationId, detail: rule.template,
    workspace: getCurrentWorkspace() });
  return conversationNotFound();
}

/** Decisions kept on the conversation stay short; the full record is the access log. */
const MAX_DECISIONS_ON_CONVERSATION = 100;

export function recordApprovalDecision(state: SharedState, actor: AccessActor | undefined, decision: {
  toolCallId: string; action: string;
}): void {
  if (!actor) return;
  const decisions = state.approvalDecisions ?? [];
  decisions.push({
    toolCallId: decision.toolCallId, action: decision.action, decidedAt: Date.now(),
    decidedBy: {
      credentialId: actor.credentialId,
      ...(actor.name ? { name: actor.name } : {}),
      ...(actor.endUser ? { endUser: actor.endUser } : {}),
    },
  });
  state.approvalDecisions = decisions.slice(-MAX_DECISIONS_ON_CONVERSATION);
}

export function auditApprovalDecision(actor: AccessActor | undefined, conversationId: string, action: string): void {
  if (!actor) return;
  recordAccessEvent({ action: 'approval.decide', actor, target: conversationId, detail: action, workspace: getCurrentWorkspace() });
}
