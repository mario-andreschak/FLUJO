/**
 * `/api/history` (#575): who changed a flow, model or MCP server, and
 * restoring an older version. With multi-user mode off it reads nothing and
 * restores nothing.
 */
const currentSharedEditor = jest.fn();
const checkBaseRevision = jest.fn();
const listHistory = jest.fn();
const getHistoryEntry = jest.fn();
const restoreHistoryEntry = jest.fn();
const loadSharedItem = jest.fn();

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/services/sharedItems/guard', () => ({
  BASE_REVISION_HEADER: 'x-flujo-base-revision',
  currentSharedEditor: (...args: unknown[]) => currentSharedEditor(...args),
  checkBaseRevision: (...args: unknown[]) => checkBaseRevision(...args),
}));
jest.mock('@/backend/services/sharedItems/history', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/history'),
  listHistory: (...args: unknown[]) => listHistory(...args),
  getHistoryEntry: (...args: unknown[]) => getHistoryEntry(...args),
}));
jest.mock('@/backend/services/sharedItems/load', () => ({ loadSharedItem: (...args: unknown[]) => loadSharedItem(...args) }));
jest.mock('@/backend/services/sharedItems/restore', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/restore'),
  restoreHistoryEntry: (...args: unknown[]) => restoreHistoryEntry(...args),
}));

import { GET, POST } from '@/app/api/history/route';

type Handler = (request: Request) => Promise<Response>;
const get = GET as unknown as Handler;
const post = POST as unknown as Handler;

const editor = { user: { id: 'u_anna000000000000000', displayName: 'Anna' }, workspace: 'sales-ws', generation: 1 };

function entry(entryId: string, at: number) {
  return {
    v: 1, entryId, at, kind: 'flow', itemId: 'f1', action: 'saved',
    actor: { userId: editor.user.id, name: 'Anna' }, revision: `f${at}`, previousRevision: null, snapshot: { secret: 'never listed' },
  };
}

const restoreRequest = (body: Record<string, unknown>, headers: Record<string, string> = {}) => new Request('http://localhost/api/history', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeEach(() => jest.clearAllMocks());

describe('with multi-user mode off', () => {
  beforeEach(() => currentSharedEditor.mockResolvedValue(null));

  it('answers enabled: false and reads no history', async () => {
    const response = await get(new Request('http://localhost/api/history?kind=flow&id=f1'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(listHistory).not.toHaveBeenCalled();
    expect(getHistoryEntry).not.toHaveBeenCalled();
  });

  it('refuses a restore with MULTI_USER_OFF and changes nothing', async () => {
    const response = await post(restoreRequest({ kind: 'flow', id: 'f1', entryId: '1800000000000-abcdef' }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'MULTI_USER_OFF' });
    expect(restoreHistoryEntry).not.toHaveBeenCalled();
    expect(loadSharedItem).not.toHaveBeenCalled();
  });
});

describe('with multi-user mode on', () => {
  beforeEach(() => currentSharedEditor.mockResolvedValue(editor));

  it('lists changes newest first, without what the item looked like', async () => {
    listHistory.mockResolvedValue([entry('1800000000000-aaaaaa', 1), entry('1800000000001-bbbbbb', 2)]);
    const response = await get(new Request('http://localhost/api/history?kind=flow&id=f1'));
    const body = await response.json();
    expect(body.enabled).toBe(true);
    expect(body.entries.map((item: { entryId: string }) => item.entryId)).toEqual(['1800000000001-bbbbbb', '1800000000000-aaaaaa']);
    expect(JSON.stringify(body)).not.toContain('never listed');
  });

  it('refuses an unknown kind', async () => {
    const response = await get(new Request('http://localhost/api/history?kind=secret&id=f1'));
    expect(response.status).toBe(400);
  });

  it('does not restore over a newer save by someone else', async () => {
    loadSharedItem.mockResolvedValue({ id: 'f1', updatedAt: 9 });
    checkBaseRevision.mockResolvedValue(Response.json({ code: 'EDIT_CONFLICT' }, { status: 409 }));
    const response = await post(restoreRequest({ kind: 'flow', id: 'f1', entryId: '1800000000000-aaaaaa', baseRevision: 'f5' }));
    expect(response.status).toBe(409);
    expect(restoreHistoryEntry).not.toHaveBeenCalled();
    const [checked] = checkBaseRevision.mock.calls[0];
    expect((checked as Request).headers.get('x-flujo-base-revision')).toBe('f5');
  });

  it('restores when the version still matches', async () => {
    loadSharedItem.mockResolvedValue({ id: 'f1', updatedAt: 5 });
    checkBaseRevision.mockResolvedValue(null);
    restoreHistoryEntry.mockResolvedValue({ item: { id: 'f1' }, entry: entry('1800000000002-cccccc', 3) });
    const response = await post(restoreRequest({ kind: 'flow', id: 'f1', entryId: '1800000000000-aaaaaa' }, { 'x-flujo-base-revision': 'f5' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ restored: true, item: { id: 'f1' }, entry: { entryId: '1800000000002-cccccc' } });
    expect(body.entry).not.toHaveProperty('snapshot');
    expect(restoreHistoryEntry).toHaveBeenCalledWith(editor, 'flow', 'f1', '1800000000000-aaaaaa');
  });
});
