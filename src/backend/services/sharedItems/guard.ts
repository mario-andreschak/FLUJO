import type { AccountUser, AccountsFile } from '@/shared/types/accounts';
import { getCurrentWorkspace } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { activeUser } from '@/backend/services/accounts/access';
import { currentAccountPrincipal } from '@/backend/services/accounts/context';
import { loadEnabledAccounts } from '@/backend/services/accounts/store';
import { SHARED_ITEM_LABELS, itemRevision, type SharedItemKind } from './kinds';
import { changedOnlyBy, lastChangeTo, listHistory, recordHistory, type HistoryAction, type HistoryEntry } from './history';
import { historySnapshot } from './secrets';

const log = createLogger('backend/services/sharedItems/guard');

/**
 * The "someone else saved first" check and change recording for the item
 * routes of flows, models and MCP servers (#575, steps 575-2 and 575-3).
 *
 * With multi-user mode off there is no signed-in person in the request, so
 * {@link currentSharedEditor} answers `null` before reading anything and every
 * helper here does nothing: FLUJO saves exactly as before.
 */

/** The version the editor started from. Flows: `f<updatedAt>`; models and MCP servers: the `revision` from `/api/edit-locks`. */
export const BASE_REVISION_HEADER = 'x-flujo-base-revision';

export interface SharedEditor {
  readonly accounts: AccountsFile;
  readonly user: AccountUser;
  readonly workspace: string;
  /** The owning team's generation, 0 for a workspace a person owns. Edit leases end when it changes. */
  readonly generation: number;
}

export function teamGeneration(accounts: AccountsFile, workspace: string): number {
  const owner = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace) ? accounts.workspaces[workspace] : undefined;
  if (owner?.ownerType !== 'team') return 0;
  return accounts.teams.find(team => team.id === owner.ownerId)?.generation ?? 0;
}

/** The signed-in person in this workspace request while multi-user mode is on, else `null`. */
export async function currentSharedEditor(now = Date.now()): Promise<SharedEditor | null> {
  const principal = currentAccountPrincipal();
  if (!principal) return null;
  const accounts = await loadEnabledAccounts();
  if (!accounts) return null;
  const user = activeUser(accounts, principal, now);
  if (!user) return null;
  const workspace = getCurrentWorkspace();
  return { accounts, user, workspace, generation: teamGeneration(accounts, workspace) };
}

export function actorOf(editor: SharedEditor): HistoryEntry['actor'] {
  return { userId: editor.user.id, name: editor.user.displayName };
}

/** The base version the request names, or `null` when it names none (older clients, quick toggles). */
export function baseRevisionOf(request: Request): string | null {
  const value = request.headers?.get?.(BASE_REVISION_HEADER)?.trim();
  return value && value.length <= 80 ? value : null;
}

export interface EditConflictBody {
  readonly error: string;
  readonly code: 'EDIT_CONFLICT';
  readonly kind: SharedItemKind;
  readonly itemId: string;
  /** Send this as the base version to save over the newer one on purpose. */
  readonly currentRevision: string;
  readonly changedBy: { readonly name: string; readonly at: number } | null;
  /** The newer version, so the page can show it or compare. */
  readonly current: unknown;
}

export function editConflictResponse(kind: SharedItemKind, itemId: string, current: unknown,
  currentRevision: string, last: HistoryEntry | null): Response {
  const who = last ? `${last.actor.name} saved` : 'Someone else saved';
  const body: EditConflictBody = {
    error: `${who} this ${SHARED_ITEM_LABELS[kind]} while you were editing it, so your changes are not saved yet. `
      + 'Load their version, compare the two, or save yours over theirs (theirs stays in the change history).',
    code: 'EDIT_CONFLICT',
    kind,
    itemId,
    currentRevision,
    changedBy: last ? { name: last.actor.name, at: last.at } : null,
    current,
  };
  return Response.json(body, { status: 409, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Refuse a save that would silently replace someone else's newer change. A
 * save passes when it names no base version, when the item is still at that
 * version, or when every change since was made by the same person (their own
 * earlier saves). Otherwise the answer is 409 with the newer version.
 */
export async function checkBaseRevision(request: Request, editor: SharedEditor | null, kind: SharedItemKind,
  itemId: string, current: unknown): Promise<Response | null> {
  const base = baseRevisionOf(request);
  if (!editor || !base || current === null || current === undefined) return null;
  const currentRevision = itemRevision(kind, current);
  if (currentRevision === base) return null;
  let entries: HistoryEntry[] = [];
  try {
    entries = await listHistory(kind, itemId);
  } catch (error) {
    log.warn(`Could not read the history of ${kind} ${itemId}; treating the save as a conflict`, error);
  }
  if (changedOnlyBy(entries, base, currentRevision, editor.user.id)) return null;
  return editConflictResponse(kind, itemId, current, currentRevision, lastChangeTo(entries, currentRevision));
}

export interface ChangeRecord {
  readonly kind: SharedItemKind;
  readonly itemId: string;
  readonly action: HistoryAction;
  /** The item before the change; `null` for a new item. */
  readonly before: unknown;
  /** The item after the change; `null` once deleted. */
  readonly after: unknown;
  readonly restoredFrom?: string;
  readonly copiedFrom?: HistoryEntry['copiedFrom'];
}

/** Write one history entry for a change a person made. Does nothing without an editor; never throws. */
export async function recordChange(editor: SharedEditor | null, change: ChangeRecord): Promise<HistoryEntry | null> {
  if (!editor) return null;
  const has = (value: unknown) => value !== null && value !== undefined;
  return recordHistory({
    kind: change.kind,
    itemId: change.itemId,
    action: change.action,
    actor: actorOf(editor),
    revision: has(change.after) ? itemRevision(change.kind, change.after) : null,
    previousRevision: has(change.before) ? itemRevision(change.kind, change.before) : null,
    snapshot: historySnapshot(change.kind, has(change.after) ? change.after : change.before),
    ...(change.restoredFrom ? { restoredFrom: change.restoredFrom } : {}),
    ...(change.copiedFrom ? { copiedFrom: change.copiedFrom } : {}),
  });
}
