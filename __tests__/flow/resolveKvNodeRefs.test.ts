/**
 * Tier 4 — engine glue for `${kv:NAME}` + captureKv.
 *
 * Pins scope resolution (global / flow / folder + folder-hash + fallbacks), the
 * mixed-scope read path, and the capture (write) path incl. scope-prefixed
 * tokens and invalid-name refusal.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { kvSet, _setKvStoreDirForTests, _clearKvStoreSettingsCache } from '@/backend/services/kvStore';
import { kvScopeId, resolveKvNodeRefs, captureKvValue } from '@/backend/execution/flow/resolveKvNodeRefs';

jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  };
});

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-kvnode-'));
  previousDir = _setKvStoreDirForTests(tmpDir);
});

afterAll(async () => {
  _setKvStoreDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _clearKvStoreSettingsCache();
});

describe('kvScopeId', () => {
  it('global is a literal board', () => {
    expect(kvScopeId('global', { flowId: 'f1' })).toBe('global');
  });

  it('flow uses the flow id', () => {
    expect(kvScopeId('flow', { flowId: 'abc-123' })).toBe('flow-abc-123');
  });

  it('folder hashes the folder name (deterministic + SAFE_ID-shaped)', () => {
    const a = kvScopeId('folder', { flowId: 'f', folder: 'My Pkg' });
    const b = kvScopeId('folder', { flowId: 'f', folder: 'My Pkg' });
    expect(a).toBe(b);
    expect(a).toMatch(/^folder-[a-f0-9]{32}$/);
  });

  it('folder falls back to the per-flow board when the flow has no folder', () => {
    expect(kvScopeId('folder', { flowId: 'f9' })).toBe('flow-f9');
  });

  it('falls back to global when the flow id is absent/unsafe', () => {
    expect(kvScopeId('flow', {})).toBe('global');
  });
});

describe('resolveKvNodeRefs (read)', () => {
  const ctx = { flowId: 'flow-read-1', folder: 'boardX' };

  it('resolves default (folder), flow/, global/ scopes and empties unknown', async () => {
    await kvSet(kvScopeId('folder', ctx), 'counter', '7');
    await kvSet(kvScopeId('flow', ctx), 'only', 'F');
    await kvSet('global', 'g', 'G');
    const text = 'c=${kv:counter} f=${kv:flow/only} g=${kv:global/g} x=${kv:missing}';
    expect(await resolveKvNodeRefs(text, ctx)).toBe('c=7 f=F g=G x=');
  });

  it('no-ops text without a kv ref', async () => {
    expect(await resolveKvNodeRefs('plain text', ctx)).toBe('plain text');
  });

  it('empties an invalid key name', async () => {
    expect(await resolveKvNodeRefs('${kv:9bad}', ctx)).toBe('');
  });
});

describe('captureKvValue (write)', () => {
  it('persists to the resolved board and reads back via ${kv:}', async () => {
    const ctx = { flowId: 'flow-cap-1', folder: 'capBoard' };
    const res = await captureKvValue('cursor', 'page-2', ctx);
    expect('skipped' in res).toBe(false);
    expect(await resolveKvNodeRefs('${kv:cursor}', ctx)).toBe('page-2');
  });

  it('honours a scope prefix on the capture token (cross-flow via global)', async () => {
    await captureKvValue('global/shared', 'S', { flowId: 'flow-cap-2', folder: 'x' });
    expect(await resolveKvNodeRefs('${kv:global/shared}', { flowId: 'a-different-flow' })).toBe('S');
  });

  it('refuses an invalid capture name', async () => {
    expect(await captureKvValue('1bad', 'v', { flowId: 'f' })).toEqual({ skipped: 'invalid-name' });
  });
});
