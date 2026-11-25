/**
 * Change history of shared items (#575, step 575-3): kept inside the
 * workspace, pruned by itself, never refusing or failing a save, and the
 * "only my own saves since" rule behind the version check.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { runWithWorkspace } from '@/utils/workspace';
import {
  HISTORY_KEEP_ENTRIES, HISTORY_PRUNE_AT_ENTRIES, changedOnlyBy, historyFilePath, listHistory, pruneEntries, recordHistory,
  type HistoryEntry,
} from '@/backend/services/sharedItems/history';
import { historySnapshot, isSecretKey, restoreSecrets } from '@/backend/services/sharedItems/secrets';

const anna = { userId: 'u_anna000000000000000', name: 'Anna' };
const ben = { userId: 'u_ben0000000000000000', name: 'Ben' };

function entry(revision: string, previousRevision: string | null, actor = anna): HistoryEntry {
  return {
    v: 1, entryId: `1800000000000-${revision.padEnd(6, 'x')}`, at: 1_800_000_000_000, kind: 'flow', itemId: 'f1',
    action: previousRevision ? 'saved' : 'created', actor, revision, previousRevision, snapshot: null,
  };
}

describe('the "only my own saves since" rule', () => {
  const entries = [entry('f1', null), entry('f2', 'f1'), entry('f3', 'f2'), entry('f4', 'f3', ben), entry('f5', 'f4')];

  it('allows a save when every change since the base was the same person', () => {
    expect(changedOnlyBy(entries, 'f1', 'f3', anna.userId)).toBe(true);
    expect(changedOnlyBy(entries, 'f3', 'f3', anna.userId)).toBe(true);
  });

  it('refuses when someone else changed it in between, or a step was not recorded', () => {
    expect(changedOnlyBy(entries, 'f1', 'f5', anna.userId)).toBe(false);
    expect(changedOnlyBy(entries, 'f4', 'f5', ben.userId)).toBe(false);
    expect(changedOnlyBy(entries, 'f1', 'f9', anna.userId)).toBe(false);
    expect(changedOnlyBy([entry('f3', 'f2')], 'f1', 'f3', anna.userId)).toBe(false);
  });

  it('stops on a loop instead of spinning', () => {
    expect(changedOnlyBy([entry('a', 'b'), entry('b', 'a')], 'z', 'a', anna.userId)).toBe(false);
  });
});

describe('history files', () => {
  let dir: string;
  const previous = process.env.FLUJO_DATA_DIR;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-history-'));
    process.env.FLUJO_DATA_DIR = dir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const inWorkspace = <T>(task: () => Promise<T>) => runWithWorkspace('sales-ws', task);

  it('keeps each item\'s history inside its own workspace', async () => {
    await inWorkspace(() => recordHistory({
      kind: 'model', itemId: 'm1', action: 'saved', actor: anna, revision: 'h2', previousRevision: 'h1', snapshot: { name: 'gpt' },
    }));
    const file = historyFilePath('model', 'm1', 'sales-ws');
    expect(file.startsWith(path.join(dir, 'workspaces', 'sales-ws', 'db', 'history', 'model'))).toBe(true);
    const entries = await inWorkspace(() => listHistory('model', 'm1'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'saved', actor: anna, revision: 'h2', previousRevision: 'h1' });
    expect(await runWithWorkspace('other-ws', () => listHistory('model', 'm1'))).toEqual([]);
  });

  it('prunes to the newest entries by itself and never refuses a write', async () => {
    await inWorkspace(async () => {
      for (let index = 0; index <= HISTORY_PRUNE_AT_ENTRIES; index++) {
        const written = await recordHistory({
          kind: 'flow', itemId: 'busy', action: 'saved', actor: anna,
          revision: `f${index + 1}`, previousRevision: `f${index}`, snapshot: { padding: 'x'.repeat(40) },
        });
        expect(written).not.toBeNull();
      }
    });
    const entries = await inWorkspace(() => listHistory('flow', 'busy'));
    expect(entries).toHaveLength(HISTORY_KEEP_ENTRIES);
    expect(entries.at(-1)?.revision).toBe(`f${HISTORY_PRUNE_AT_ENTRIES + 1}`);
  });

  it('keeps the newest entries within the byte limit too', () => {
    const big = Array.from({ length: 5 }, (_, index) => ({ ...entry(`f${index}`, null), snapshot: 'y'.repeat(1000) }));
    expect(pruneEntries(big, 200, 2500).map(item => item.revision)).toEqual(['f3', 'f4']);
    // A single entry larger than the limit is still kept: the newest change is never lost.
    expect(pruneEntries(big, 200, 10)).toHaveLength(1);
  });

  it('skips a line cut short by a crash and keeps the rest readable', async () => {
    await inWorkspace(() => recordHistory({ kind: 'flow', itemId: 'torn', action: 'created', actor: anna, revision: 'f1', previousRevision: null, snapshot: null }));
    await fs.appendFile(historyFilePath('flow', 'torn', 'sales-ws'), '{"v":1,"entryId":"18000');
    await inWorkspace(() => recordHistory({ kind: 'flow', itemId: 'torn', action: 'saved', actor: ben, revision: 'f2', previousRevision: 'f1', snapshot: null }));
    const entries = await inWorkspace(() => listHistory('flow', 'torn'));
    expect(entries.map(item => item.revision)).toEqual(['f1', 'f2']);
  });

  it('never throws when the history cannot be written; the save goes on', async () => {
    await fs.mkdir(path.join(dir, 'workspaces', 'sales-ws', 'db'), { recursive: true });
    await fs.writeFile(path.join(dir, 'workspaces', 'sales-ws', 'db', 'history'), 'not a folder');
    await expect(inWorkspace(() => recordHistory({
      kind: 'flow', itemId: 'f1', action: 'saved', actor: anna, revision: 'f2', previousRevision: 'f1', snapshot: null,
    }))).resolves.toBeNull();
  });
});

describe('secrets never reach the history', () => {
  it('masks model keys and MCP secrets but keeps settings and global references', () => {
    expect(historySnapshot('model', { id: 'm1', ApiKey: 'encrypted:abc', maxTokens: 100, temperature: '0.2' }))
      .toEqual({ id: 'm1', ApiKey: MASKED_API_KEY, maxTokens: 100, temperature: '0.2' });
    expect(historySnapshot('model', { id: 'm1', ApiKey: '${global:OPENAI_KEY}' })).toEqual({ id: 'm1', ApiKey: '${global:OPENAI_KEY}' });
    const server = historySnapshot('mcp-server', {
      name: 'github', command: 'npx', env: { GITHUB_TOKEN: { value: 'encrypted:x', metadata: { isSecret: true } }, MODE: 'fast' },
      headers: { Authorization: 'Bearer abc' }, oauthTokens: { access_token: 'secret' }, oauthClientSecret: 'shh',
    });
    expect(server).toEqual({
      name: 'github', command: 'npx', env: { GITHUB_TOKEN: { value: MASKED_API_KEY, metadata: { isSecret: true } }, MODE: 'fast' },
      headers: { Authorization: MASKED_API_KEY }, oauthClientSecret: MASKED_API_KEY,
    });
    expect(JSON.stringify(server)).not.toMatch(/encrypted:|abc|shh|access_token/);
  });

  it('masks secret-looking settings anywhere in a flow, not token counts', () => {
    const flow = historySnapshot('flow', {
      id: 'f1', nodes: [{ data: { properties: { apiKey: 'sk-live', password: 'p', maxTokens: 50, note: 'encrypted:zz' } } }],
    }) as { nodes: Array<{ data: { properties: Record<string, unknown> } }> };
    expect(flow.nodes[0].data.properties).toEqual({ apiKey: MASKED_API_KEY, password: MASKED_API_KEY, maxTokens: 50, note: MASKED_API_KEY });
    expect(['maxTokens', 'contextTokens', 'promptTemplate'].some(isSecretKey)).toBe(false);
    expect(['ApiKey', 'clientSecret', 'oauthTokens', 'Authorization', 'access_token', 'token'].every(isSecretKey)).toBe(true);
  });

  it('puts today\'s secret back when an older version is restored', () => {
    expect(restoreSecrets({ ApiKey: MASKED_API_KEY, temperature: '0.1' }, { ApiKey: MASKED_API_KEY, temperature: '0.9' }))
      .toEqual({ ApiKey: MASKED_API_KEY, temperature: '0.1' });
    expect(restoreSecrets({ env: { KEY: { value: MASKED_API_KEY } } }, { env: { KEY: { value: 'encrypted:now' } } }))
      .toEqual({ env: { KEY: { value: 'encrypted:now' } } });
  });
});
