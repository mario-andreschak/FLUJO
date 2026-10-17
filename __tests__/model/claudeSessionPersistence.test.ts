import fs from 'fs';
import path from 'path';
import os from 'os';
import { acquireClaudeSession, computePrefixHash, computeHistoryHash, findReusableSession,
  recordSession, invalidateSession, _reloadClaudeSessionsForTests } from '@/backend/services/model/adapters/claudeSessionStore';
import { hasClaudeSessionTranscript, captureClaudeSessionTranscript, acquireDurableClaudeSession, sessionValueHash, claudeSdkRuntimeIdentity } from '@/backend/services/model/adapters/claudeSessionPersistence';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-claude-session-'));
const history = [{ role: 'system', content: 'A' }, { role: 'user', content: 'ticket 123' }, { role: 'assistant', content: 'remembered' }];
const prefix = computePrefixHash('A', [{ name: 'tool', description: 'first', parameters: { type: 'object' } }], { systemPromptPolicy: 'per-turn' });
beforeEach(() => { process.env.FLUJO_TEST_CLAUDE_SESSION_DIR = root; _reloadClaudeSessionsForTests(); });
afterEach(() => { delete process.env.FLUJO_TEST_CLAUDE_SESSION_DIR; _reloadClaudeSessionsForTests(); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('reads an ESM SDK identity from the selected installation without executing its entry', () => {
  const installation = path.join(root, 'relocated-installation');
  const sdk = path.join(installation, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk',
    type: 'module', version: '0.3.296-fixture', claudeCodeVersion: '2.1.296-fixture', exports: { '.': './sdk.mjs' } }));
  fs.writeFileSync(path.join(sdk, 'sdk.mjs'), 'throw new Error("SDK entry must not execute during identity lookup");');
  expect(claudeSdkRuntimeIdentity(installation)).toEqual({ sdkVersion: '0.3.296-fixture', bundledRuntimeVersion: '2.1.296-fixture' });
});

it('recovers metadata after a backend restart and rejects same-length edits', () => {
  recordSession('conversation::node', { sessionId: 'session-1', prefixHash: prefix,
    seenMessageCount: history.length, leadingSystemMessageCount: 1, historyHash: computeHistoryHash(history, 1),
    usageCheckpoint: { modelUsage: {} } });
  _reloadClaudeSessionsForTests();
  expect(findReusableSession('conversation::node', prefix, [...history, { role: 'user', content: 'new' }], 1)?.sessionId).toBe('session-1');
  expect(findReusableSession('conversation::node', prefix, history.map((message, index) => index === 1 ? { ...message, content: 'edited ticket' } : message), 1)).toBeUndefined();
  expect(findReusableSession('conversation::node', prefix, history.slice(0, 2), 1)).toBeUndefined();
  expect(findReusableSession('other::node', prefix, history, 1)).toBeUndefined();
  invalidateSession('conversation::node'); _reloadClaudeSessionsForTests();
  expect(findReusableSession('conversation::node', prefix, history, 1)).toBeUndefined();
});

it('allows prompt-only change under per-turn policy but rejects schema/configuration or stable-prompt changes', () => {
  const tools = [{ name: 'tool', parameters: { type: 'object' } }];
  expect(computePrefixHash('A', tools, { systemPromptPolicy: 'per-turn' })).toBe(computePrefixHash('B', tools, { systemPromptPolicy: 'per-turn' }));
  expect(computePrefixHash('A', tools)).not.toBe(computePrefixHash('B', tools));
  expect(computePrefixHash('A', tools)).not.toBe(computePrefixHash('A', [{ ...tools[0], description: 'changed' }]));
  expect(computePrefixHash('A', tools, { model: 'first' })).not.toBe(computePrefixHash('A', tools, { model: 'second' }));
});

it('treats corrupt metadata and missing/truncated SDK transcripts as a fresh-session fallback', async () => {
  fs.mkdirSync(path.join(root, 'db', 'claude-sessions-v2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'db', 'claude-sessions-v2', `${sessionValueHash('conversation::node')}.json`), '{bad-json'); _reloadClaudeSessionsForTests();
  expect(findReusableSession('conversation::node', prefix, history, 1)).toBeUndefined();
  expect(await captureClaudeSessionTranscript(root, 'missing')).toBeUndefined();
  const project = path.join(root, 'projects', 'workspace'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'valid.jsonl'), '{"type":"user"}\n');
  const checkpoint = await captureClaudeSessionTranscript(root, 'valid');
  expect(checkpoint).toBeDefined();
  expect(await hasClaudeSessionTranscript(root, 'valid', checkpoint!)).toBe(true);
  fs.writeFileSync(path.join(project, 'valid.jsonl'), '{"type":');
  expect(await hasClaudeSessionTranscript(root, 'valid', checkpoint!)).toBe(false);
  expect(await captureClaudeSessionTranscript(root, '../valid')).toBeUndefined();
});

it('rejects complete-record truncation and same-length transcript edits', async () => {
  const project = path.join(root, 'projects', 'workspace'); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'lineage.jsonl');
  const first = '{"type":"user","content":"ticket 123"}\n';
  const second = '{"type":"assistant","content":"remembered"}\n';
  fs.writeFileSync(file, first + second);
  const checkpoint = await captureClaudeSessionTranscript(root, 'lineage');
  expect(checkpoint).toMatchObject({ records: 2 });
  fs.writeFileSync(file, first);
  expect(await hasClaudeSessionTranscript(root, 'lineage', checkpoint!)).toBe(false);
  fs.writeFileSync(file, first.replace('123', '456') + second);
  expect(await hasClaudeSessionTranscript(root, 'lineage', checkpoint!)).toBe(false);
});

it('recovers a dead lease owner without permitting a second recoverer to remove the new owner', async () => {
  const lease = path.join(root, 'db', 'claude-sessions-v2', 'leases', `${sessionValueHash('recovery')}.lock`);
  const oldNonce = '00000000-0000-4000-8000-000000000001';
  const newNonce = '00000000-0000-4000-8000-000000000002';
  const oldFile = path.join(lease, `2147483647.${oldNonce}.json`);
  const newFile = path.join(lease, `${process.pid}.${newNonce}.json`);
  fs.mkdirSync(lease, { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ pid: 2147483647, nonce: oldNonce }));
  const kill = jest.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 2147483647) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
    return true;
  });
  const originalUnlink = fs.unlinkSync;
  const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(file => {
    // Another recoverer won immediately after we read the old generation.
    originalUnlink(file); fs.rmdirSync(lease); fs.mkdirSync(lease);
    fs.writeFileSync(newFile, JSON.stringify({ pid: process.pid, nonce: newNonce }));
    throw Object.assign(new Error('old generation already removed'), { code: 'ENOENT' });
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await expect(acquireDurableClaudeSession('recovery', controller.signal)).rejects.toThrow('cancelled');
    expect(JSON.parse(fs.readFileSync(newFile, 'utf8')).nonce).toBe(newNonce);
  } finally {
    clearTimeout(timer); unlink.mockRestore(); kill.mockRestore(); fs.rmSync(lease, { recursive: true });
  }
});

it('does not publish a lease when owner initialization fails and can recover an empty abandoned lease', async () => {
  const lease = path.join(root, 'db', 'claude-sessions-v2', 'leases', `${sessionValueHash('init-crash')}.lock`);
  const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('initialization interrupted'); });
  try { await expect(acquireDurableClaudeSession('init-crash')).rejects.toThrow('initialization interrupted'); }
  finally { write.mockRestore(); }
  expect(fs.existsSync(lease)).toBe(false);
  fs.mkdirSync(lease);
  const release = await acquireDurableClaudeSession('init-crash');
  expect(fs.readdirSync(lease)).toHaveLength(1);
  release();
  expect(fs.existsSync(lease)).toBe(false);
});

it('releases successfully when a waiter publishes a new generation before the directory removal', async () => {
  const lease = path.join(root, 'db', 'claude-sessions-v2', 'leases', `${sessionValueHash('release-race')}.lock`);
  const release = await acquireDurableClaudeSession('release-race');
  const replacement = path.join(lease, `${process.pid}.00000000-0000-4000-8000-000000000003.json`);
  const originalUnlink = fs.unlinkSync;
  const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(file => {
    originalUnlink(file);
    fs.writeFileSync(replacement, JSON.stringify({ pid: process.pid, nonce: '00000000-0000-4000-8000-000000000003' }));
  });
  try { expect(release).not.toThrow(); expect(fs.existsSync(replacement)).toBe(true); }
  finally { unlink.mockRestore(); fs.rmSync(lease, { recursive: true }); }
});

it('serializes the same session, leaves other sessions independent, and does not wedge after cancellation', async () => {
  const first = await acquireClaudeSession('same');
  const controller = new AbortController();
  const cancelled = acquireClaudeSession('same', controller.signal);
  controller.abort(); await expect(cancelled).rejects.toThrow('cancelled');
  const other = await acquireClaudeSession('other'); other();
  let acquired = false;
  const third = acquireClaudeSession('same').then(release => { acquired = true; release(); });
  await Promise.resolve(); expect(acquired).toBe(false);
  first(); await third; expect(acquired).toBe(true);
});
