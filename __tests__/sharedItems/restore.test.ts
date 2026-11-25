/**
 * Restoring an older version from the change history (#575, step 575-3).
 * A restore is a new save that brings back settings but never a key, and it
 * is itself recorded as `restored`.
 */
import { MASKED_API_KEY } from '@/shared/types/constants';
import type { HistoryEntry } from '@/backend/services/sharedItems/history';
import type { SharedEditor } from '@/backend/services/sharedItems/guard';

const saveFlow = jest.fn();
const updateModel = jest.fn();
const addModel = jest.fn();
const updateServerConfig = jest.fn();
const loadSharedItem = jest.fn();
const getHistoryEntry = jest.fn();
const recordChange = jest.fn();

jest.mock('@/backend/services/flow', () => ({ flowService: { saveFlow: (...args: unknown[]) => saveFlow(...args) } }));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    updateModel: (...args: unknown[]) => updateModel(...args),
    addModel: (...args: unknown[]) => addModel(...args),
  },
}));
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { updateServerConfig: (...args: unknown[]) => updateServerConfig(...args) },
}));
jest.mock('@/backend/services/sharedItems/load', () => ({ loadSharedItem: (...args: unknown[]) => loadSharedItem(...args) }));
jest.mock('@/backend/services/sharedItems/history', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/history'),
  getHistoryEntry: (...args: unknown[]) => getHistoryEntry(...args),
}));
jest.mock('@/backend/services/sharedItems/guard', () => ({ recordChange: (...args: unknown[]) => recordChange(...args) }));

import { RestoreError, restoreHistoryEntry } from '@/backend/services/sharedItems/restore';

const editor = { user: { id: 'u_anna000000000000000', displayName: 'Anna' }, workspace: 'sales-ws', generation: 1 } as unknown as SharedEditor;

function entry(kind: HistoryEntry['kind'], itemId: string, snapshot: unknown, entryId = '1800000000000-abcdef'): HistoryEntry {
  return {
    v: 1, entryId, at: 1_800_000_000_000, kind, itemId, action: 'saved',
    actor: { userId: 'u_ben0000000000000000', name: 'Ben' }, revision: 'h1', previousRevision: 'h0', snapshot,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  recordChange.mockResolvedValue({ entryId: '1800000000001-zzzzzz' });
});

describe('restoring an older version', () => {
  it('keeps the stored MCP secrets and records a restore', async () => {
    getHistoryEntry.mockResolvedValue(entry('mcp-server', 'github', {
      name: 'github', transport: 'stdio', command: 'old-command',
      env: { GITHUB_TOKEN: { value: MASKED_API_KEY, metadata: { isSecret: true } }, MODE: 'old' },
    }));
    const current = {
      name: 'github', transport: 'stdio', command: 'new-command',
      env: { GITHUB_TOKEN: { value: 'encrypted:current-secret', metadata: { isSecret: true } }, MODE: 'new' },
      oauthTokens: { format: 'flujo-oauth-v1', ciphertext: 'kept' },
    };
    const after = { ...current, command: 'old-command', env: { ...current.env, MODE: 'old' } };
    loadSharedItem.mockResolvedValueOnce(current).mockResolvedValueOnce(after);
    updateServerConfig.mockResolvedValue(after);

    const result = await restoreHistoryEntry(editor, 'mcp-server', 'github', '1800000000000-abcdef');

    const [name, saved] = updateServerConfig.mock.calls[0];
    expect(name).toBe('github');
    expect(saved.command).toBe('old-command');
    expect(saved.env.MODE).toBe('old');
    // The current key goes back in; the old (masked) one never reaches storage.
    expect(saved.env.GITHUB_TOKEN).toEqual({ value: 'encrypted:current-secret', metadata: { isSecret: true } });
    expect(JSON.stringify(saved)).not.toContain(MASKED_API_KEY);
    // OAuth sign-in state is not part of a snapshot, so the merge keeps what is stored.
    expect(saved).not.toHaveProperty('oauthTokens');
    expect(recordChange).toHaveBeenCalledWith(editor, expect.objectContaining({
      kind: 'mcp-server', itemId: 'github', action: 'restored', before: current, after, restoredFrom: '1800000000000-abcdef',
    }));
    expect(result.item).toBe(after);
  });

  it('never sends an old model key; the save keeps the stored one', async () => {
    getHistoryEntry.mockResolvedValue(entry('model', 'm1', {
      id: 'm1', name: 'gpt-old', displayName: 'Old', provider: 'openai', ApiKey: MASKED_API_KEY, temperature: '0.2',
    }));
    loadSharedItem.mockResolvedValue({ id: 'm1', name: 'gpt-new', displayName: 'New', provider: 'openai', ApiKey: MASKED_API_KEY });
    updateModel.mockResolvedValue({ success: true });

    await restoreHistoryEntry(editor, 'model', 'm1', '1800000000000-abcdef');

    const saved = updateModel.mock.calls[0][0];
    expect(saved).toMatchObject({ id: 'm1', name: 'gpt-old', displayName: 'Old', temperature: '0.2' });
    // `********` is the save path's "keep the stored key".
    expect(saved.ApiKey).toBe(MASKED_API_KEY);
    expect(addModel).not.toHaveBeenCalled();
  });

  it('keeps a flow with its Persona and checks nobody saved in between', async () => {
    getHistoryEntry.mockResolvedValue(entry('flow', 'f1', {
      id: 'f1', name: 'Old flow', nodes: [], edges: [], personaOwnership: { personaId: 'forged' }, updatedAt: 5,
    }));
    loadSharedItem.mockResolvedValue({ id: 'f1', name: 'New flow', nodes: [], edges: [], personaOwnership: { personaId: 'p1' }, updatedAt: 9 });
    saveFlow.mockResolvedValue({ success: true });

    await restoreHistoryEntry(editor, 'flow', 'f1', '1800000000000-abcdef');

    const [saved, options] = saveFlow.mock.calls[0];
    expect(saved).toMatchObject({ id: 'f1', name: 'Old flow', personaOwnership: { personaId: 'p1' } });
    expect(options).toEqual({ expectedUpdatedAt: 9 });
  });

  it('answers 409 when someone saved the flow during the restore', async () => {
    getHistoryEntry.mockResolvedValue(entry('flow', 'f1', { id: 'f1', name: 'Old flow', nodes: [], edges: [] }));
    loadSharedItem.mockResolvedValue({ id: 'f1', name: 'New flow', nodes: [], edges: [], updatedAt: 9 });
    saveFlow.mockResolvedValue({ success: false, error: 'Flow changed since inspection.' });

    await expect(restoreHistoryEntry(editor, 'flow', 'f1', '1800000000000-abcdef'))
      .rejects.toMatchObject({ status: 409, code: 'EDIT_CONFLICT' });
    expect(recordChange).not.toHaveBeenCalled();
  });

  it('says plainly when the version is gone', async () => {
    getHistoryEntry.mockResolvedValue(null);
    await expect(restoreHistoryEntry(editor, 'model', 'm1', 'missing')).rejects.toBeInstanceOf(RestoreError);
    await expect(restoreHistoryEntry(editor, 'model', 'm1', 'missing')).rejects.toMatchObject({ status: 404 });
    expect(updateModel).not.toHaveBeenCalled();
  });
});
