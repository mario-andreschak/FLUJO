import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { EDIT_LEASE_MS, EDIT_LEASE_RENEW_MS, otherEditors, releaseEditLease, takeEditLease } from '@/backend/services/sharedItems/editLeases';
import { currentSharedEditor } from '@/backend/services/sharedItems/guard';
import { SHARED_ITEM_LABELS, isSharedItemId, isSharedItemKind, itemRevision, type SharedItemKind } from '@/backend/services/sharedItems/kinds';
import { loadSharedItem } from '@/backend/services/sharedItems/load';

const log = createLogger('app/api/edit-locks/route');

/**
 * "Anna is editing" notes for flows, models and MCP servers (#575).
 *
 * - `GET ?kind=&id=`: who else has the item open, and its current version.
 * - `POST { kind, id }`: open or keep open (renew every 20 seconds); answers
 *   the same plus `lease`. The version is what the editor sends back as
 *   `x-flujo-base-revision` when it saves.
 * - `DELETE ?kind=&id=`: the editor closed.
 *
 * Only while multi-user mode is on. With it off every call answers
 * `{ enabled: false }` and nothing is kept.
 */

const OFF = { enabled: false } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function target(request: Request): Promise<{ kind: SharedItemKind; id: string } | Response> {
  let kind: unknown = null;
  let id: unknown = null;
  try {
    const url = new URL(request.url);
    kind = url.searchParams.get('kind');
    id = url.searchParams.get('id');
  } catch { /* relative test URL */ }
  if ((kind === null || id === null) && request.method === 'POST') {
    try {
      const body = await request.json() as Record<string, unknown>;
      kind = body?.kind;
      id = body?.id;
    } catch { /* no body */ }
  }
  if (!isSharedItemKind(kind) || !isSharedItemId(id)) {
    return json({ error: 'Say which item: kind (flow, model or mcp-server) and id.' }, 400);
  }
  return { kind, id };
}

async function describe(request: Request, take: boolean): Promise<Response> {
  // Mode off: answer before reading anything (not even the lock state).
  const editor = await currentSharedEditor();
  if (!editor) return json(OFF);
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  try {
    const item = await target(request);
    if (item instanceof Response) return item;
    const current = await loadSharedItem(item.kind, item.id);
    if (!current) return json({ error: `This ${SHARED_ITEM_LABELS[item.kind]} does not exist (any more).` }, 404);
    const name = editor.user.displayName;
    const now = Date.now();
    const leased = take
      ? takeEditLease({ workspace: editor.workspace, kind: item.kind, itemId: item.id, userId: editor.user.id, name, generation: editor.generation }, now)
      : { lease: null, others: otherEditors(editor.workspace, item.kind, item.id, editor.user.id, editor.generation, now) };
    return json({
      enabled: true,
      kind: item.kind,
      id: item.id,
      revision: itemRevision(item.kind, current),
      lease: leased.lease ? { expiresAt: leased.lease.expiresAt, since: leased.lease.since } : null,
      others: leased.others.map(other => ({ name: other.name, since: other.since })),
      leaseMs: EDIT_LEASE_MS,
      renewInMs: EDIT_LEASE_RENEW_MS,
    });
  } catch (error) {
    log.error('Edit note request failed', error);
    return json({ error: 'Could not check who is editing. Try again.' }, 500);
  }
}

async function GET_handler(request: NextRequest): Promise<Response> {
  return describe(request, false);
}

async function POST_handler(request: NextRequest): Promise<Response> {
  return describe(request, true);
}

async function DELETE_handler(request: NextRequest): Promise<Response> {
  const editor = await currentSharedEditor();
  if (!editor) return json(OFF);
  const item = await target(request);
  if (item instanceof Response) return item;
  releaseEditLease(editor.workspace, item.kind, item.id, editor.user.id);
  return json({ enabled: true, released: true });
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
