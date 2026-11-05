/**
 * Retention periods for stored conversations, on real files in a throwaway data folder.
 * The real-run cases use real nodes, runFlow and the adapter against a loopback model
 * server. Only MCP and the model catalogue are replaced.
 */
import { promises as fs } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';

const mockFailDeletes = new Set<string>();
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    deleteCollectionItem: async (collection: string, id: string) => {
      if (collection === 'conversations' && mockFailDeletes.has(id)) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return actual.deleteCollectionItem(collection, id);
    },
  };
});
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    loadServerConfigs: async () => [],
    getClient: () => ({}),
    getClientGeneration: () => 0,
    getToolSchemaHash: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
let mockBaseUrl = '';
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'retention-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'retention-model', name: 'retention-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { listConversationSummaries } from '@/backend/execution/flow/conversationSummaryStore';
import { _setConversationLogDirForTests } from '@/backend/execution/flow/conversationLog';
import { recoveryOwnerId } from '@/backend/execution/flow/recoveryCheckpoint';
import type { SharedState } from '@/backend/execution/flow/types';
import { clearPendingQuestions, registerPendingQuestion } from '@/backend/services/questionRegistry';
import { putPendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { appendRunRecord, loadRunRecords } from '@/backend/services/scheduler/runHistory';
import {
  deleteConversationCompletely,
  finishInterruptedConversationDeletions,
} from '@/backend/services/conversations/deletion';
import { getConversationRetentionStatus, runConversationRetention } from '@/backend/services/conversations/retention';
import { effectiveRetentionDays } from '@/shared/types/conversationRetention';
import { flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';
import { DELETE as deleteOne } from '@/app/v1/chat/conversations/[conversationId]/route';
import { DELETE as deleteMany } from '@/app/v1/chat/conversations/route';

jest.setTimeout(120_000);

const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'PRIVATE-MARKER-4711';
const db = (...parts: string[]) => path.join(getWorkspaceDataDir(), 'db', ...parts);
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

async function write(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

/** A stored conversation with real files and a date of `ageDays` ago. */
async function stored(id: string, ageDays = 40, extra: Partial<SharedState> & Record<string, unknown> = {}): Promise<void> {
  const at = Date.now() - ageDays * DAY;
  const file = db('conversations', `${id}.json`);
  await write(file, {
    conversationId: id, flowId: 'plain-flow', status: 'completed', title: `${SECRET} title`,
    messages: [{ id: 'm1', role: 'user', content: `${SECRET} question` }],
    createdAt: at, updatedAt: at, ...extra,
  });
  await fs.utimes(file, new Date(at), new Date(at));
}

/** Everything a conversation can have attached to it. */
async function withEverythingAttached(id: string, ageDays = 40): Promise<string[]> {
  const at = new Date(Date.now() - ageDays * DAY);
  const invocation = `inv-${id}`;
  const files = [
    db('conversations', `${id}.json.corrupted.123.bak`),
    db('conversation-summaries', `${id}.json`),
    db('conversation-logs', `${id}.jsonl`),
    db('model-turns', id, 'd1.v2.json.gz'),
    db('model-turns', id, 'media', 'abc'),
    db('run-resources', id, 'index.json'),
    db('run-resources', id, 'r1.dat'),
    db('run-resources', id, 'r2.png'),
    db('native-tool-journal', 'tools', invocation, 'tool.json'),
    db('native-session-payloads', invocation, 'p.json'),
    db('native-session-origins', `${invocation}.json`),
    db('native-tool-journal', 'calls', `${invocation}.json`),
    db('subflow-tasks', `task-${id}.json`),
    db('harness-observations', 'profile-a', `obs-${id}.json`),
  ];
  for (const file of files) await write(file, `${SECRET} attached`);
  await write(db('native-tool-journal', 'calls', `${invocation}.json`), {
    invocationId: invocation, state: 'terminal', owner: { conversationId: id }, marker: SECRET,
  });
  await write(db('subflow-tasks', `task-${id}.json`), {
    taskId: `task-${id}`, status: 'completed', originConversationId: id, childConversationId: `${id}-child`,
    input: { prompt: SECRET }, outputText: SECRET, updatedAt: at.getTime(), createdAt: at.getTime(),
  });
  await write(db('harness-observations', 'profile-a', `obs-${id}.json`), {
    id: `obs-${id}`, profileId: 'profile-a', sourceRunId: 'other', conversationId: id, createdAt: Date.now(),
    input: SECRET, output: SECRET, tools: [],
  });
  await fs.utimes(db('conversation-logs', `${id}.jsonl`), at, at);
  return files;
}

async function filesHolding(text: string, root = getWorkspaceDataDir()): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesHolding(text, target));
    else if ((await fs.readFile(target)).includes(text)) found.push(path.relative(getWorkspaceDataDir(), target));
  }
  return found;
}

const turnOn = (settings: Record<string, unknown> = { days: 30 }) =>
  saveItem(StorageKey.SPEECH_SETTINGS, { speech: {}, conversationRetention: { enabled: true, ...settings } });

const quick = { pauseMs: 0 };

// The test setup sends conversation logs elsewhere. Here they belong with everything else.
let previousLogDir: string;
beforeAll(() => { previousLogDir = _setConversationLogDirForTests(db('conversation-logs')); });
afterAll(() => { _setConversationLogDirForTests(previousLogDir); });

beforeEach(async () => {
  mockFailDeletes.clear();
  FlowExecutor.conversationStates.clear();
  await fs.rm(path.join(getWorkspaceDataDir(), 'db'), { recursive: true, force: true, maxRetries: 5 });
  await fs.mkdir(path.join(getWorkspaceDataDir(), 'db'), { recursive: true });
});

describe('which period applies', () => {
  it('is off unless the workspace turned it on, whatever a flow says', () => {
    expect(effectiveRetentionDays(undefined, 5)).toBeUndefined();
    expect(effectiveRetentionDays({ enabled: false, days: 5 }, 5)).toBeUndefined();
  });

  it('takes the shorter period by default, and a flow cannot lift the limit', () => {
    const on = { enabled: true, days: 30 };
    expect(effectiveRetentionDays(on, undefined)).toBe(30);
    expect(effectiveRetentionDays(on, 7)).toBe(7);
    expect(effectiveRetentionDays(on, 90)).toBe(30);
    expect(effectiveRetentionDays(on, 0)).toBe(30);
    expect(effectiveRetentionDays({ enabled: true }, 7)).toBe(7);
    expect(effectiveRetentionDays({ enabled: true }, undefined)).toBeUndefined();
  });

  it('lets the flow decide when the workspace chose that', () => {
    const on = { enabled: true, days: 30, precedence: 'flow' as const };
    expect(effectiveRetentionDays(on, 90)).toBe(90);
    expect(effectiveRetentionDays(on, 7)).toBe(7);
    expect(effectiveRetentionDays(on, 0)).toBeUndefined();
    expect(effectiveRetentionDays(on, undefined)).toBe(30);
  });

  it('counts a wrong value as not set, so a typo can only keep more', () => {
    for (const bad of [-1, 1.5, '30', Number.NaN, 99_999]) {
      expect(effectiveRetentionDays({ enabled: true }, bad)).toBeUndefined();
      expect(effectiveRetentionDays({ enabled: true, days: bad as number }, undefined)).toBeUndefined();
    }
  });

  it('survives a trip through the flow format', () => {
    const flow = { id: 'f', name: 'f', conversationRetentionDays: 14, nodes: [], edges: [] } as unknown as Flow;
    expect(flowToSpec(flow).conversationRetentionDays).toBe(14);
  });
});

describe('the sweep', () => {
  it('does nothing while switched off', async () => {
    await stored('off-old', 4000);
    expect(await runConversationRetention(quick)).toBeUndefined();
    expect(await exists(db('conversations', 'off-old.json'))).toBe(true);
    expect((await getConversationRetentionStatus()).enabled).toBe(false);
  });

  it('removes an old conversation with everything attached and keeps a recent one', async () => {
    await turnOn();
    await stored('old-a');
    const attached = await withEverythingAttached('old-a');
    await stored('recent-a', 2);
    await appendRunRecord('sched-1', {
      runId: 'r-old', conversationId: 'old-a', firedAt: new Date(Date.now() - 40 * DAY).toISOString(),
      status: 'completed', triggerSummary: 'Schedule', outputText: `${SECRET} output`, error: `${SECRET} error`,
    });
    await stored('old-b', 40, { plannedExecutionId: 'sched-1' });
    await appendRunRecord('sched-1', {
      runId: 'r-recent', conversationId: 'recent-a', firedAt: new Date().toISOString(),
      status: 'completed', triggerSummary: 'Schedule', outputText: 'recent output',
    });

    const report = await runConversationRetention(quick);

    expect(report).toMatchObject({ deleted: 2, failed: 0, incomplete: 0, runRecordsCleared: 1 });
    expect(report!.kept.recent).toBe(1);
    expect(await exists(db('conversations', 'old-a.json'))).toBe(false);
    for (const file of attached) expect([file, await exists(file)]).toEqual([file, false]);
    expect(await exists(db('conversations', 'recent-a.json'))).toBe(true);
    // The history row stays, its text does not.
    const rows = await loadRunRecords('sched-1');
    expect(rows.map(row => row.runId)).toEqual(['r-old', 'r-recent']);
    expect(rows[0].outputText).toBeUndefined();
    expect(rows[0].error).toBeUndefined();
    expect(rows[1].outputText).toBe('recent output');
    // Only recent-a still holds the marker.
    const left = await filesHolding(SECRET);
    expect(left.filter(file => !file.includes('recent-a') && !file.endsWith('status.json'))).toEqual([]);
    expect(await exists(db('conversation-deletions', 'old-a.json'))).toBe(false);
  });

  it('never removes what is in use, however old', async () => {
    await turnOn();
    await stored('keep-running', 400, { status: 'running', recovery: { ownerId: recoveryOwnerId() } as never });
    await stored('keep-approval', 400, { status: 'awaiting_tool_approval' });
    await stored('keep-debug', 400, { status: 'paused_debug' });
    await stored('keep-pending-tools', 400, { pendingToolCalls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: '{}' } }] as never });
    await stored('keep-subflow-open', 400, { subflowInvocations: { i: { status: 'blocked' } } as never });
    await stored('keep-persona', 400, { personaTargetId: 'p1' });
    await stored('keep-persona-archive', 400, { personaArchived: true });
    await stored('keep-inbox', 400);
    await stored('keep-history', 400);
    await stored('keep-task', 400);
    await stored('keep-native', 400);
    await putPendingApproval({
      approvalId: 'keep-inbox', conversationId: 'keep-inbox', plannedExecutionId: 's', flowId: 'f', runId: 'r',
      triggerSummary: 't', pendingToolCalls: [], createdAt: new Date().toISOString(),
    });
    await appendRunRecord('sched-2', {
      runId: 'r', conversationId: 'keep-history', firedAt: new Date(0).toISOString(), status: 'needs_approval', triggerSummary: 't',
    });
    await saveCollectionItem('subflow-tasks', 'open-task', { taskId: 'open-task', status: 'working', originConversationId: 'keep-task', childConversationId: 'c' });
    await write(db('native-tool-journal', 'calls', 'held.json'), { invocationId: 'held', state: 'unknown', owner: { conversationId: 'keep-native' } });
    await stored('gone-too', 400);

    const report = await runConversationRetention(quick);

    expect(report!.deleted).toBe(1);
    expect(report!.kept).toMatchObject({ running: 1, waiting: 4, persona: 2, schedule: 2, subflow_task: 1, native_unresolved: 1 });
    expect(await exists(db('conversations', 'gone-too.json'))).toBe(false);
    for (const id of ['keep-running', 'keep-approval', 'keep-debug', 'keep-pending-tools', 'keep-subflow-open', 'keep-persona', 'keep-persona-archive', 'keep-inbox', 'keep-history', 'keep-task', 'keep-native']) {
      expect([id, await exists(db('conversations', `${id}.json`))]).toEqual([id, true]);
    }
    expect(await exists(db('native-tool-journal', 'calls', 'held.json'))).toBe(true);
  });

  it('removes a run that died with its process, which nothing will ever move on', async () => {
    await turnOn();
    await stored('crashed', 400, { status: 'running', recovery: { ownerId: 'a-previous-process' } as never });
    expect((await runConversationRetention(quick))!.deleted).toBe(1);
  });

  it('keeps a live conversation and one with an open question', async () => {
    await turnOn();
    await stored('live-one', 400);
    FlowExecutor.conversationStates.set('live-one', { conversationId: 'live-one', status: 'running', messages: [], updatedAt: 1 } as never);
    await stored('asking', 400);
    const question = registerPendingQuestion('asking', 'q1', [{ prompt: 'Which one?', options: ['a', 'b'] }] as never);
    const report = await runConversationRetention(quick);
    expect(report!.deleted).toBe(0);
    expect(report!.kept).toMatchObject({ running: 1, waiting: 1 });
    clearPendingQuestions('asking');
    await question;
  });

  it('counts age from stored dates, so a restored backup does not start over', async () => {
    await turnOn();
    await stored('restored');
    await fs.utimes(db('conversations', 'restored.json'), new Date(), new Date());
    expect((await runConversationRetention(quick))!.deleted).toBe(1);
  });

  it('treats fresh writing to the event log as activity', async () => {
    await turnOn();
    await stored('being-written');
    await write(db('conversation-logs', 'being-written.jsonl'), 'x');
    const report = await runConversationRetention(quick);
    expect(report!.deleted).toBe(0);
    expect(report!.kept.recent).toBe(1);
  });

  it('uses the summary when it matches the state file, and the file when it does not', async () => {
    await turnOn();
    await stored('summarised');
    await listConversationSummaries();
    expect(await exists(db('conversation-summaries', 'summarised.json'))).toBe(true);
    // A summary that does not match says nothing: this one claims it is recent.
    await stored('stale-summary');
    await write(db('conversation-summaries', 'stale-summary.json'), { version: 1, id: 'stale-summary', updatedAt: Date.now(), snapshotMtimeMs: 1, snapshotSize: 1 });
    expect((await runConversationRetention(quick))!.deleted).toBe(2);
  });

  it('applies a flow period, shorter by default and longer when the flow decides', async () => {
    await saveCollectionItem('flows', 'short-flow', { id: 'short-flow', name: 's', conversationRetentionDays: 5, nodes: [], edges: [] });
    await saveCollectionItem('flows', 'long-flow', { id: 'long-flow', name: 'l', conversationRetentionDays: 90, nodes: [], edges: [] });
    await stored('short-10', 10, { flowId: 'short-flow' });
    await stored('long-40', 40, { flowId: 'long-flow' });
    await stored('plain-40', 40);
    await stored('plain-10', 10);

    await turnOn({ days: 30, precedence: 'flow' });
    expect((await runConversationRetention({ ...quick, dryRun: true }))!.deleted).toBe(2); // short-10, plain-40

    await turnOn({ days: 30 });
    expect((await runConversationRetention({ ...quick, dryRun: true }))!.deleted).toBe(3); // and long-40

    await turnOn({});
    expect((await runConversationRetention(quick))!.deleted).toBe(1); // only the flow with a period
    expect(await exists(db('conversations', 'short-10.json'))).toBe(false);
    expect(await exists(db('conversations', 'plain-40.json'))).toBe(true);
  });

  it('treats a conversation and its subflow children as one', async () => {
    await turnOn();
    await stored('root-active', 2);
    await stored('child-of-active', 40, { parentConversationId: 'root-active', rootConversationId: 'root-active' });
    await stored('root-waiting', 40);
    await stored('child-of-waiting', 40, { parentConversationId: 'root-waiting', status: 'awaiting_tool_approval' });
    await stored('root-idle', 40);
    await stored('child-of-idle', 40, { parentConversationId: 'root-idle', rootConversationId: 'root-idle' });
    await stored('grandchild-of-idle', 40, { parentConversationId: 'child-of-idle' });

    const report = await runConversationRetention(quick);

    expect(report!.deleted).toBe(3);
    expect(await exists(db('conversations', 'child-of-active.json'))).toBe(true);
    expect(await exists(db('conversations', 'root-waiting.json'))).toBe(true);
    expect(await exists(db('conversations', 'root-idle.json'))).toBe(false);
    expect(await exists(db('conversations', 'grandchild-of-idle.json'))).toBe(false);
  });

  it('goes around a corrupt file, keeps it, and makes no copies of it', async () => {
    await turnOn();
    await write(db('conversations', 'broken.json'), `{ not json ${SECRET}`);
    await write(db('conversations', 'empty.json'), '');
    await write(db('conversations', 'list.json'), '[1,2]');
    await stored('fine');
    for (let round = 0; round < 3; round += 1) {
      const report = await runConversationRetention(quick);
      expect(report!.kept.unreadable).toBe(3);
      expect(report!.error).toBeUndefined();
    }
    expect((await fs.readdir(db('conversations'))).sort()).toEqual(['broken.json', 'empty.json', 'list.json']);
  });

  it('carries on when one conversation cannot be removed, and it stays usable', async () => {
    await turnOn();
    await stored('stuck');
    await stored('free');
    mockFailDeletes.add('stuck');
    const report = await runConversationRetention(quick);
    expect(report).toMatchObject({ deleted: 1, failed: 1 });
    expect(await exists(db('conversations', 'stuck.json'))).toBe(true);
    expect(await exists(db('conversation-deletions', 'stuck.json'))).toBe(false);
    mockFailDeletes.clear();
    expect((await runConversationRetention(quick))!.deleted).toBe(1);
  });

  it('removes nothing when it cannot tell what is in use', async () => {
    await turnOn();
    await stored('unsure');
    // A file where the native journal needs a folder makes reading it fail.
    await write(db('native-tool-journal', 'calls'), 'not a folder');
    const report = await runConversationRetention(quick);
    expect(report!.error).toBe('protection_unavailable');
    expect(await exists(db('conversations', 'unsure.json'))).toBe(true);
  });

  it('gets through a batch without holding up other work', async () => {
    await turnOn();
    const ids = Array.from({ length: 40 }, (_, index) => `mass-${index}`);
    await Promise.all(ids.map((id, index) => stored(id, index % 2 ? 40 : 2)));
    let longestGap = 0;
    let previous = Date.now();
    const sampler = setInterval(() => {
      longestGap = Math.max(longestGap, Date.now() - previous);
      previous = Date.now();
    }, 5);
    const report = await runConversationRetention({ batchSize: 10, pauseMs: 1 });
    clearInterval(sampler);
    expect(report).toMatchObject({ scanned: 40, deleted: 20, failed: 0 });
    expect(report!.kept.recent).toBe(20);
    // Generous, because this PC is shared. A sweep that blocked would take far longer.
    expect(longestGap).toBeLessThan(3_000);
    expect((await fs.readdir(db('conversations'))).length).toBe(20);
  });

  it('shares one run between overlapping calls', async () => {
    await turnOn();
    await stored('once');
    const [first, second] = await Promise.all([runConversationRetention(quick), runConversationRetention(quick)]);
    expect(first).toBe(second);
    expect(first!.deleted).toBe(1);
  });
});

describe('dry run', () => {
  it('says how many would go, and removes and clears nothing', async () => {
    await turnOn();
    await stored('dry-old');
    await withEverythingAttached('dry-old');
    await stored('dry-new', 1);
    await appendRunRecord('sched-3', {
      runId: 'r', conversationId: '', firedAt: new Date(Date.now() - 40 * DAY).toISOString(), status: 'completed',
      triggerSummary: 't', outputText: SECRET,
    });
    const before = (await filesHolding(SECRET)).sort();

    const report = await runConversationRetention({ dryRun: true });

    expect(report).toMatchObject({ dryRun: true, deleted: 1, runRecordsCleared: 1 });
    expect((await filesHolding(SECRET)).filter(file => !file.endsWith('status.json')).sort()).toEqual(before);
    expect((await loadRunRecords('sched-3'))[0].outputText).toBe(SECRET);
  });

  it('can try a period before retention is turned on', async () => {
    await stored('try-old');
    expect(await runConversationRetention({ dryRun: true })).toBeUndefined();
    const report = await runConversationRetention({ dryRun: true, settings: { enabled: true, days: 30 } });
    expect(report!.deleted).toBe(1);
    expect(await exists(db('conversations', 'try-old.json'))).toBe(true);
  });
});

describe('status', () => {
  it('reports counts only and is still there after a restart', async () => {
    await turnOn({ days: 30, precedence: 'flow' });
    await stored('status-old');
    await runConversationRetention(quick);
    await new Promise(resolve => setTimeout(resolve, 50));

    const status = await getConversationRetentionStatus();
    expect(status).toMatchObject({ enabled: true, days: 30, precedence: 'flow', running: false, lastRun: { deleted: 1, dryRun: false } });
    const text = JSON.stringify(status);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('status-old');

    (globalThis as { __flujoConversationRetentionStatus?: Map<string, unknown> }).__flujoConversationRetentionStatus?.clear();
    expect((await getConversationRetentionStatus()).lastRun?.deleted).toBe(1);
  });
});

describe('stopping halfway', () => {
  it('finishes a deletion a restart interrupted', async () => {
    await withEverythingAttached('half-done');
    await write(db('conversation-deletions', 'half-done.json'), { version: 1, conversationId: 'half-done', startedAt: Date.now() - 1000 });

    // This runs with retention off too.
    expect(await runConversationRetention(quick)).toBeUndefined();

    expect(await exists(db('conversation-deletions', 'half-done.json'))).toBe(false);
    expect(await exists(db('conversation-logs', 'half-done.jsonl'))).toBe(false);
    expect(await exists(db('run-resources', 'half-done'))).toBe(false);
    expect(await filesHolding(SECRET)).toEqual([]);
  });

  it('finishes when the state file survived the interruption', async () => {
    await stored('half-state');
    await write(db('conversation-deletions', 'half-state.json'), { version: 1, conversationId: 'half-state', startedAt: Date.now() });
    await finishInterruptedConversationDeletions();
    expect(await exists(db('conversations', 'half-state.json'))).toBe(false);
  });

  it('finishes even when the state file is broken', async () => {
    await write(db('conversations', 'half-broken.json'), '{ nope');
    await write(db('conversation-deletions', 'half-broken.json'), { version: 1, conversationId: 'half-broken', startedAt: Date.now() });
    expect((await finishInterruptedConversationDeletions()).finished).toBe(1);
    expect(await exists(db('conversations', 'half-broken.json'))).toBe(false);
  });

  it('leaves alone a conversation created again under the same id', async () => {
    await stored('reborn', 0);
    await write(db('conversation-deletions', 'reborn.json'), { version: 1, conversationId: 'reborn', startedAt: Date.now() - DAY });
    await finishInterruptedConversationDeletions();
    expect(await exists(db('conversations', 'reborn.json'))).toBe(true);
    expect(await exists(db('conversation-deletions', 'reborn.json'))).toBe(false);
  });

  it('keeps the marker while a file cannot be removed, and retries', async () => {
    await turnOn();
    await stored('leftover');
    // A folder in place of the log file makes removing it fail, as a locked file would.
    await fs.mkdir(db('conversation-logs', 'leftover.jsonl', 'sub'), { recursive: true });
    await fs.utimes(db('conversation-logs', 'leftover.jsonl'), new Date(0), new Date(0));

    const report = await runConversationRetention(quick);
    expect(report).toMatchObject({ deleted: 1, incomplete: 1 });
    expect(await exists(db('conversation-deletions', 'leftover.json'))).toBe(true);
    expect(await exists(db('conversations', 'leftover.json'))).toBe(false);

    await fs.rm(db('conversation-logs', 'leftover.jsonl'), { recursive: true });
    await write(db('conversation-logs', 'leftover.jsonl'), SECRET);
    const next = await runConversationRetention(quick);
    expect(next!.resumedDeletions).toBe(1);
    expect(await exists(db('conversation-logs', 'leftover.jsonl'))).toBe(false);
    expect(await exists(db('conversation-deletions', 'leftover.json'))).toBe(false);
  });
});

describe('the delete routes use the same path', () => {
  const request = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, {
    method: 'DELETE', headers: { host: 'localhost', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  it('removes everything through the single delete', async () => {
    await stored('route-one');
    const attached = await withEverythingAttached('route-one');
    const response = await deleteOne(request('/v1/chat/conversations/route-one'), { params: Promise.resolve({ conversationId: 'route-one' }) });
    expect(response.status).toBe(204);
    for (const file of attached) expect([file, await exists(file)]).toEqual([file, false]);
    expect(await exists(db('conversation-deletions', 'route-one.json'))).toBe(false);
  });

  it('refuses a bad id and an active Persona conversation, removing nothing', async () => {
    const bad = await deleteOne(request('/v1/chat/conversations/x'), { params: Promise.resolve({ conversationId: '..%2Fx' }) });
    expect(bad.status).toBe(400);
    await stored('route-persona', 40, { personaArchived: true });
    const refused = await deleteOne(request('/v1/chat/conversations/route-persona'), { params: Promise.resolve({ conversationId: 'route-persona' }) });
    expect(refused.status).toBe(409);
    expect(await exists(db('conversations', 'route-persona.json'))).toBe(true);
    expect(await exists(db('conversation-deletions', 'route-persona.json'))).toBe(false);
  });

  it('answers 500 and leaves a conversation usable when its file cannot go', async () => {
    await stored('route-stuck');
    mockFailDeletes.add('route-stuck');
    const response = await deleteOne(request('/v1/chat/conversations/route-stuck'), { params: Promise.resolve({ conversationId: 'route-stuck' }) });
    expect(response.status).toBe(500);
    expect(await exists(db('conversation-deletions', 'route-stuck.json'))).toBe(false);
    const state = { conversationId: 'route-stuck', status: 'completed', messages: [], updatedAt: 5, title: 'still here', flowId: 'f' } as unknown as SharedState;
    await persistConversationState('conversations/route-stuck' as StorageKey, state);
    expect(JSON.parse(await fs.readFile(db('conversations', 'route-stuck.json'), 'utf8')).title).toBe('still here');
  });

  it('now also removes model-turn archives through bulk delete', async () => {
    await stored('bulk-a');
    const attached = await withEverythingAttached('bulk-a');
    await stored('bulk-persona', 40, { personaTargetId: 'p' });
    const response = await deleteMany(request('/v1/chat/conversations', { ids: ['bulk-a', 'bulk-persona', '../bad'] }));
    expect(await response.json()).toMatchObject({ deleted: 1, errors: 2 });
    for (const file of attached) expect([file, await exists(file)]).toEqual([file, false]);
    expect(await exists(db('conversations', 'bulk-persona.json'))).toBe(true);
  });
});

describe('real runs', () => {
  let server: Server;
  let requests = 0;
  let hold: Promise<void> | undefined;
  let arrived: (() => void) | undefined;

  function answer(response: ServerResponse, body: Record<string, unknown>) {
    const completion = { id: 'c', object: 'chat.completion', created: 1, model: 'retention-fixture' };
    const content = `${SECRET} answer`;
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
        choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
        choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...completion, choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null } }] }));
    }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests += 1;
        arrived?.();
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        void (hold ?? Promise.resolve()).then(() => answer(response, body));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  beforeEach(async () => {
    requests = 0;
    hold = undefined;
    arrived = undefined;
    FlowExecutor.clearFlowCache();
    await saveItem(StorageKey.MODELS, [{ id: 'retention-model', name: 'retention-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
  });

  const node = (id: string, type: string, properties: Record<string, unknown> = {}): FlowNode =>
    ({ id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } }) as FlowNode;
  const flow = (id: string): Flow => ({
    id,
    name: id,
    nodes: [node('start', 'start'), node('work', 'process', { boundModel: 'retention-model', promptTemplate: 'Work.' }), node('end', 'finish')],
    edges: [
      { id: 'a', source: 'start', target: 'work', data: { edgeType: 'standard' } },
      { id: 'b', source: 'work', target: 'end', data: { edgeType: 'standard' } },
    ],
  }) as unknown as Flow;
  const run = (id: string, definition: Flow) => runFlow({
    conversationId: id, flowDefinition: definition, prompt: `${SECRET} question`, source: 'api', mode: 'conversation', flujo: true, userTurn: true,
  });

  it('leaves no trace of a real run anywhere in the data folder, and nothing comes back', async () => {
    await turnOn();
    const result = await run('real-all', flow('real-all'));
    expect(result.status).toBe('completed');
    expect(requests).toBe(1);
    const state = FlowExecutor.conversationStates.get('real-all')!;
    expect(await exists(db('conversations', 'real-all.json'))).toBe(true);
    expect((await filesHolding(SECRET)).length).toBeGreaterThan(0);

    const report = await runConversationRetention({ ...quick, now: Date.now() + 40 * DAY });
    expect(report).toMatchObject({ deleted: 1, incomplete: 0, failed: 0 });
    expect(await filesHolding(SECRET)).toEqual([]);

    // A late write from whoever still holds the old state is refused.
    await persistConversationState('conversations/real-all' as StorageKey, state);
    expect(await exists(db('conversations', 'real-all.json'))).toBe(false);
    expect((await listConversationSummaries()).map(item => item.id)).not.toContain('real-all');
    const again = await runConversationRetention({ ...quick, now: Date.now() + 40 * DAY });
    expect(again!.scanned).toBe(0);
  });

  it('does not touch a conversation whose run is going, and that run finishes normally', async () => {
    await turnOn();
    await run('real-during', flow('real-during'));
    // As after a restart: not in memory, and last used long ago.
    FlowExecutor.conversationStates.clear();
    const file = db('conversations', 'real-during.json');
    const old = Date.now() - 40 * DAY;
    await write(file, { ...JSON.parse(await fs.readFile(file, 'utf8')), updatedAt: old, lastUserMessageAt: old, createdAt: old });
    await fs.utimes(db('conversation-logs', 'real-during.jsonl'), new Date(old), new Date(old));

    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { arrived = resolve; });
    const going = run('real-during', flow('real-during'));
    await reached;

    const during = await runConversationRetention(quick);
    expect(during!.deleted).toBe(0);
    expect(during!.kept.running).toBe(1);

    release();
    const finished = await going;
    expect(finished.status).toBe('completed');
    expect(finished.outputText).toContain(SECRET);

    const after = await runConversationRetention(quick);
    expect(after!.deleted).toBe(0);
    expect(after!.kept.recent).toBe(1);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as SharedState;
    expect(saved.updatedAt).toBeGreaterThan(Date.now() - DAY);
  });

  it('does not wait for a lock it finds taken', async () => {
    await turnOn();
    await stored('locked-now');
    let unlock!: () => void;
    const held = withConversationExecutionLock('locked-now', () => new Promise<void>(resolve => { unlock = resolve; }));
    const report = await runConversationRetention(quick);
    expect(report!.kept.busy).toBe(1);
    expect(await exists(db('conversations', 'locked-now.json'))).toBe(true);
    unlock();
    await held;
  });

  it('cancels a running run when a person deletes it, as before', async () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { arrived = resolve; });
    const going = run('real-cancel', flow('real-cancel'));
    await reached;
    const deleting = deleteConversationCompletely('real-cancel', { cancelRunning: true });
    release();
    await going;
    expect(await deleting).toMatchObject({ deleted: true });
    expect(await exists(db('conversations', 'real-cancel.json'))).toBe(false);
    expect(await exists(db('conversation-logs', 'real-cancel.jsonl'))).toBe(false);
  });
});
