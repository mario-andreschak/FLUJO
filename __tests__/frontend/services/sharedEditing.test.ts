/**
 * Browser side of "someone else saved first" (#575): saves name the version
 * their editor started from, and a 409 EDIT_CONFLICT becomes a clear
 * `conflict` result instead of a generic failure.
 */
import { flowService } from '@/frontend/services/flow';
import { modelService } from '@/frontend/services/model';
import {
  BASE_REVISION_HEADER, clearEditBase, describeDifferences, editConflictFrom, setEditBase,
} from '@/frontend/services/sharedItems';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const conflictBody = {
  error: 'Ben saved this flow while you were editing it.',
  code: 'EDIT_CONFLICT',
  kind: 'flow',
  itemId: 'f1',
  currentRevision: 'f20',
  changedBy: { name: 'Ben', at: 1_800_000_000_000 },
  current: { id: 'f1', name: 'Theirs', nodes: [], edges: [], updatedAt: 20 },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const previousFetch = global.fetch;
let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = previousFetch;
  clearEditBase('flow', 'f1');
  clearEditBase('model', 'm1');
});

function sentHeaders(call = 0): Headers {
  return new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers);
}

describe('reading a refused save', () => {
  it('turns a 409 EDIT_CONFLICT into a conflict with who and when', () => {
    const conflict = editConflictFrom(409, conflictBody);
    expect(conflict).toMatchObject({
      kind: 'flow', itemId: 'f1', currentRevision: 'f20', changedBy: { name: 'Ben' }, message: conflictBody.error,
    });
  });

  it('leaves other refusals alone', () => {
    expect(editConflictFrom(409, { error: 'A flow with that name already exists' })).toBeNull();
    expect(editConflictFrom(400, conflictBody)).toBeNull();
  });

  it('lists the settings that differ, in plain words', () => {
    expect(describeDifferences({ name: 'Mine', nodes: [1, 2], updatedAt: 1 }, { name: 'Theirs', nodes: [1, 2], updatedAt: 2 }))
      .toEqual([{ field: 'name', mine: 'Mine', theirs: 'Theirs' }]);
  });
});

describe('saving a flow', () => {
  it('names the version the builder opened and reports a conflict', async () => {
    setEditBase('flow', 'f1', 'f10');
    fetchMock.mockResolvedValue(jsonResponse(409, conflictBody));
    const result = await flowService.updateFlow({ id: 'f1', name: 'Mine', nodes: [], edges: [] });
    expect(sentHeaders().get(BASE_REVISION_HEADER)).toBe('f10');
    expect(result.success).toBe(false);
    expect(result.conflict).toMatchObject({ currentRevision: 'f20', changedBy: { name: 'Ben' } });
    expect(result.error).toBe(conflictBody.error);
  });

  it('falls back to the flow\'s own version and keeps the new stamp after a save', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'f1', name: 'Mine', nodes: [], edges: [], updatedAt: 31, createdAt: 3 }));
    const flow = { id: 'f1', name: 'Mine', nodes: [], edges: [], updatedAt: 30 };
    const result = await flowService.updateFlow(flow);
    expect(sentHeaders().get(BASE_REVISION_HEADER)).toBe('f30');
    expect(result).toEqual({ success: true });
    // The page keeps this object, so its next save names the version it now shows.
    expect(flow.updatedAt).toBe(31);
  });

  it('sends no version when nobody knows one (older pages keep working)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'f1', name: 'Mine', nodes: [], edges: [] }));
    await flowService.updateFlow({ id: 'f1', name: 'Mine', nodes: [], edges: [] });
    expect(sentHeaders().has(BASE_REVISION_HEADER)).toBe(false);
  });
});

describe('saving a model', () => {
  // The model service only runs in a browser; a bare window is enough for the refused saves below.
  const globals = globalThis as { window?: unknown };
  beforeAll(() => { globals.window = {}; });
  afterAll(() => { delete globals.window; });

  it('names the version its editor opened and reports a conflict', async () => {
    setEditBase('model', 'm1', 'habc');
    fetchMock.mockResolvedValue(jsonResponse(409, { ...conflictBody, kind: 'model', itemId: 'm1', currentRevision: 'hdef' }));
    const result = await modelService.updateModel({ id: 'm1', name: 'gpt', ApiKey: '********', provider: 'openai' });
    expect(sentHeaders().get(BASE_REVISION_HEADER)).toBe('habc');
    expect(result.success).toBe(false);
    expect(result.conflict).toMatchObject({ kind: 'model', currentRevision: 'hdef' });
  });

  it('keeps other failures as plain errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'Provider is required' }));
    const result = await modelService.updateModel({ id: 'm1', name: 'gpt', ApiKey: '' });
    expect(result).toEqual({ success: false, error: 'Provider is required' });
  });
});
