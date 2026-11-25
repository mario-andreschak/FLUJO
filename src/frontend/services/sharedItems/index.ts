/**
 * Browser side of shared editing in team workspaces (#575): whether
 * multi-user mode is on, "Anna is editing" leases, the version an editor
 * started from, the "someone else saved first" answer, and change history.
 *
 * With multi-user mode off the server answers `{ enabled: false }` and the
 * hooks built on this module ask nothing else: no lease, no history request.
 */

export type SharedItemKind = 'flow' | 'model' | 'mcp-server';

/** Sent on saves: the version the editor started from (see `guard.ts` on the server). */
export const BASE_REVISION_HEADER = 'x-flujo-base-revision';
/** Window event for a save refused because someone else saved first. */
export const EDIT_CONFLICT_EVENT = 'flujo:edit-conflict';

// ---------------------------------------------------------------------------
// Multi-user mode (asked once per page load)
// ---------------------------------------------------------------------------

let modePromise: Promise<boolean> | null = null;

/** True while sign-in for several people is on. Asked once per page load; a failed check counts as off and is asked again next time. */
export function isMultiUserMode(): Promise<boolean> {
  if (modePromise) return modePromise;
  let request: Promise<Response>;
  try {
    request = fetch('/api/accounts/session', { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    // No way to ask (an old browser or a test page): behave as a single-user install.
    return Promise.resolve(false);
  }
  modePromise = request
    .then(async response => {
      if (!response.ok) return false;
      const body: unknown = await response.json();
      return Boolean(body && typeof body === 'object' && (body as { mode?: unknown }).mode === 'on');
    })
    .catch(() => {
      modePromise = null;
      return false;
    });
  return modePromise;
}

/** Forget the cached answer (tests, and after turning the mode on or off). */
export function resetMultiUserModeCache(): void {
  modePromise = null;
}

// ---------------------------------------------------------------------------
// The version each open editor started from
// ---------------------------------------------------------------------------

const bases = new Map<string, string>();
const baseKey = (kind: SharedItemKind, id: string) => `${kind}\u0000${id}`;

/** The version of a flow as the server counts it: its `updatedAt` stamp. */
export function flowRevision(updatedAt: unknown): string {
  return `f${typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0}`;
}

export function setEditBase(kind: SharedItemKind, id: string, revision: string | null): void {
  if (revision) bases.set(baseKey(kind, id), revision);
  else bases.delete(baseKey(kind, id));
}

export function getEditBase(kind: SharedItemKind, id: string): string | null {
  return bases.get(baseKey(kind, id)) ?? null;
}

export function clearEditBase(kind: SharedItemKind, id: string): void {
  bases.delete(baseKey(kind, id));
}

/** The header for a save, or none when no editor registered a version (quick toggles, older pages). */
export function baseRevisionHeaders(kind: SharedItemKind, id: string, explicit?: string | null): Record<string, string> {
  const revision = explicit ?? getEditBase(kind, id);
  return revision ? { [BASE_REVISION_HEADER]: revision } : {};
}

// ---------------------------------------------------------------------------
// "Someone else saved first"
// ---------------------------------------------------------------------------

export interface EditConflict {
  readonly kind: SharedItemKind;
  readonly itemId: string;
  /** A plain explanation for people. */
  readonly message: string;
  /** Send this as the base version to save over the newer one on purpose. */
  readonly currentRevision: string;
  readonly changedBy: { readonly name: string; readonly at: number } | null;
  /** The newer version as stored now. */
  readonly current: unknown;
}

/** Read a 409 `EDIT_CONFLICT` answer body. Anything else is `null`. */
export function editConflictFrom(status: number, body: unknown): EditConflict | null {
  if (status !== 409 || !body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (value.code !== 'EDIT_CONFLICT' || typeof value.currentRevision !== 'string') return null;
  const kind = value.kind === 'flow' || value.kind === 'model' || value.kind === 'mcp-server' ? value.kind : null;
  if (!kind || typeof value.itemId !== 'string') return null;
  const changedBy = value.changedBy && typeof value.changedBy === 'object'
    && typeof (value.changedBy as { name?: unknown }).name === 'string'
    && typeof (value.changedBy as { at?: unknown }).at === 'number'
    ? { name: (value.changedBy as { name: string }).name, at: (value.changedBy as { at: number }).at }
    : null;
  return {
    kind,
    itemId: value.itemId,
    message: typeof value.error === 'string' && value.error
      ? value.error
      : 'Someone else saved this while you were editing it, so your changes are not saved yet.',
    currentRevision: value.currentRevision,
    changedBy,
    current: value.current ?? null,
  };
}

export interface EditConflictEventDetail {
  readonly conflict: EditConflict;
  /** What this person tried to save. */
  readonly mine: unknown;
  /** Save `mine` over the newer version on purpose. Resolves `true` when saved. */
  readonly saveMine: () => Promise<boolean>;
}

/** Tell the page about a refused save (used where the save result does not travel back to the editor). */
export function announceEditConflict(detail: EditConflictEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<EditConflictEventDetail>(EDIT_CONFLICT_EVENT, { detail }));
}

// ---------------------------------------------------------------------------
// Edit leases
// ---------------------------------------------------------------------------

export interface OtherEditor {
  readonly name: string;
  readonly since: number;
}

export interface EditLeaseAnswer {
  readonly enabled: boolean;
  /** The item's version now. */
  readonly revision: string | null;
  readonly others: readonly OtherEditor[];
  readonly renewInMs: number;
}

function itemQuery(kind: SharedItemKind, id: string): string {
  return `kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;
}

function parseLease(body: unknown): EditLeaseAnswer | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (value.enabled !== true) return { enabled: false, revision: null, others: [], renewInMs: 0 };
  const others = Array.isArray(value.others)
    ? value.others.flatMap(other => other && typeof other === 'object'
      && typeof (other as { name?: unknown }).name === 'string'
      ? [{ name: (other as { name: string }).name, since: Number((other as { since?: unknown }).since) || 0 }]
      : [])
    : [];
  return {
    enabled: true,
    revision: typeof value.revision === 'string' ? value.revision : null,
    others,
    renewInMs: typeof value.renewInMs === 'number' && value.renewInMs >= 5000 ? value.renewInMs : 20_000,
  };
}

/** Open or keep open an editor. `null` when the server could not answer (for example a viewer, who may not edit). */
export async function takeEditLease(kind: SharedItemKind, id: string, signal?: AbortSignal): Promise<EditLeaseAnswer | null> {
  try {
    const response = await fetch('/api/edit-locks', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    return parseLease(await response.json());
  } catch {
    return null;
  }
}

/** The editor closed. Uses `keepalive` so it still goes out while the page unloads. */
export function releaseEditLease(kind: SharedItemKind, id: string): void {
  try {
    void fetch(`/api/edit-locks?${itemQuery(kind, id)}`, {
      method: 'DELETE', credentials: 'same-origin', keepalive: true,
    }).catch(() => undefined);
  } catch { /* the lease ends by itself within a minute */ }
}

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------

export type HistoryAction = 'created' | 'saved' | 'restored' | 'deleted' | 'copied-in';

export interface HistorySummary {
  readonly entryId: string;
  readonly at: number;
  readonly action: HistoryAction;
  readonly actor: { readonly userId: string | null; readonly name: string };
  readonly revision: string | null;
  readonly restoredFrom?: string;
  readonly copiedFrom?: { readonly workspace: string; readonly itemId: string };
}

export interface HistoryEntry extends HistorySummary {
  readonly snapshot: unknown;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorOf(body: Record<string, unknown>, fallback: string): string {
  return typeof body.error === 'string' && body.error ? body.error : fallback;
}

/** Who changed the item, newest first. `enabled: false` while multi-user mode is off. */
export async function loadHistory(kind: SharedItemKind, id: string):
  Promise<{ enabled: boolean; entries: HistorySummary[]; error?: string }> {
  const response = await fetch(`/api/history?${itemQuery(kind, id)}`, { credentials: 'same-origin', cache: 'no-store' });
  const body = await readJson(response);
  if (!response.ok) return { enabled: true, entries: [], error: errorOf(body, 'Could not read the change history.') };
  if (body.enabled !== true) return { enabled: false, entries: [] };
  return { enabled: true, entries: Array.isArray(body.entries) ? body.entries as HistorySummary[] : [] };
}

export async function loadHistoryEntry(kind: SharedItemKind, id: string, entryId: string):
  Promise<{ entry: HistoryEntry | null; error?: string }> {
  const response = await fetch(`/api/history?${itemQuery(kind, id)}&entry=${encodeURIComponent(entryId)}`,
    { credentials: 'same-origin', cache: 'no-store' });
  const body = await readJson(response);
  if (!response.ok || !body.entry) return { entry: null, error: errorOf(body, 'Could not read that version.') };
  return { entry: body.entry as HistoryEntry };
}

export type RestoreAnswer =
  | { readonly ok: true; readonly item: unknown }
  | { readonly ok: false; readonly error: string; readonly conflict: EditConflict | null };

/** Bring back an older version as a new save. */
export async function restoreHistoryEntry(kind: SharedItemKind, id: string, entryId: string,
  baseRevision?: string | null): Promise<RestoreAnswer> {
  try {
    const response = await fetch('/api/history', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id, entryId, ...(baseRevision ? { baseRevision } : {}) }),
    });
    const body = await readJson(response);
    if (response.ok) return { ok: true, item: body.item ?? null };
    return {
      ok: false,
      error: errorOf(body, 'Could not restore that version. Try again.'),
      conflict: editConflictFrom(response.status, body),
    };
  } catch {
    return { ok: false, error: 'Could not reach FLUJO. Check that it is still running, then try again.', conflict: null };
  }
}

// ---------------------------------------------------------------------------
// Comparing two versions
// ---------------------------------------------------------------------------

export interface FieldDifference {
  readonly field: string;
  readonly mine: string;
  readonly theirs: string;
}

const IGNORED_FIELDS = new Set(['updatedAt', 'createdAt']);

function describeValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(empty)';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Top-level fields that differ between my version and theirs, in plain words. */
export function describeDifferences(mine: unknown, theirs: unknown): FieldDifference[] {
  const left = mine && typeof mine === 'object' && !Array.isArray(mine) ? mine as Record<string, unknown> : {};
  const right = theirs && typeof theirs === 'object' && !Array.isArray(theirs) ? theirs as Record<string, unknown> : {};
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(field => !IGNORED_FIELDS.has(field))
    .sort((a, b) => a.localeCompare(b));
  const differences: FieldDifference[] = [];
  for (const field of fields) {
    const a = left[field];
    const b = right[field];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    let mineText = describeValue(a);
    let theirsText = describeValue(b);
    if (mineText === theirsText) {
      mineText = `${mineText} (changed inside)`;
      theirsText = `${theirsText} (changed inside)`;
    }
    differences.push({ field, mine: mineText, theirs: theirsText });
  }
  return differences;
}
