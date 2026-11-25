import { NextRequest } from 'next/server';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { BASE_REVISION_HEADER, checkBaseRevision, currentSharedEditor } from '@/backend/services/sharedItems/guard';
import { getHistoryEntry, listHistory, summarize } from '@/backend/services/sharedItems/history';
import { isSharedItemId, isSharedItemKind, type SharedItemKind } from '@/backend/services/sharedItems/kinds';
import { loadSharedItem } from '@/backend/services/sharedItems/load';
import { RestoreError, restoreHistoryEntry } from '@/backend/services/sharedItems/restore';

const log = createLogger('app/api/history/route');

/**
 * Change history of flows, models and MCP servers (#575, step 575-3).
 *
 * - `GET ?kind=&id=`: who changed the item and when, newest first (no snapshots).
 * - `GET ?kind=&id=&entry=`: one entry with what the item looked like (secrets masked).
 * - `POST { kind, id, entryId, baseRevision? }`: restore that version as a new
 *   save. Like any save, it answers 409 when someone else saved after
 *   `baseRevision` (or the `x-flujo-base-revision` header).
 *
 * Only while multi-user mode is on. With it off, GET answers
 * `{ enabled: false }` and POST 409 `MULTI_USER_OFF`, and nothing is read.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function itemFrom(kind: unknown, id: unknown): { kind: SharedItemKind; id: string } | Response {
  if (!isSharedItemKind(kind) || !isSharedItemId(id)) {
    return json({ error: 'Say which item: kind (flow, model or mcp-server) and id.' }, 400);
  }
  return { kind, id };
}

async function GET_handler(request: NextRequest): Promise<Response> {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  try {
    const editor = await currentSharedEditor();
    if (!editor) return json({ enabled: false });
    const url = new URL(request.url);
    const item = itemFrom(url.searchParams.get('kind'), url.searchParams.get('id'));
    if (item instanceof Response) return item;
    const entryId = url.searchParams.get('entry');
    if (entryId) {
      const entry = await getHistoryEntry(item.kind, item.id, entryId);
      if (!entry) return json({ error: 'That version is no longer in the history.' }, 404);
      return json({ enabled: true, entry });
    }
    const entries = (await listHistory(item.kind, item.id)).map(summarize).reverse();
    return json({ enabled: true, kind: item.kind, id: item.id, entries });
  } catch (error) {
    log.error('Reading change history failed', error);
    return json({ error: 'Could not read the change history. Try again.' }, 500);
  }
}

async function POST_handler(request: NextRequest): Promise<Response> {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;
  try {
    const editor = await currentSharedEditor();
    if (!editor) {
      return json({ error: 'Change history is part of sign-in for several people, which is off.', code: 'MULTI_USER_OFF' }, 409);
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await request.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch { /* answered below */ }
    const item = itemFrom(body.kind, body.id);
    if (item instanceof Response) return item;
    if (typeof body.entryId !== 'string' || !body.entryId) return json({ error: 'Say which version to restore.' }, 400);
    const base = typeof body.baseRevision === 'string' && body.baseRevision
      ? body.baseRevision
      : request.headers.get(BASE_REVISION_HEADER);
    if (base) {
      const current = await loadSharedItem(item.kind, item.id);
      const conflict = await checkBaseRevision(
        new Request('http://localhost/', { headers: { [BASE_REVISION_HEADER]: base } }),
        editor, item.kind, item.id, current,
      );
      if (conflict) return conflict;
    }
    const restored = await restoreHistoryEntry(editor, item.kind, item.id, body.entryId);
    return json({ restored: true, item: restored.item, entry: restored.entry ? summarize(restored.entry) : null });
  } catch (error) {
    if (error instanceof RestoreError) return json({ error: error.message, code: error.code }, error.status);
    log.error('Restoring an older version failed', error);
    return json({ error: 'Could not restore that version. Try again.' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
