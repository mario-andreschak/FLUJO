/**
 * MCP events against a real outside event source (#1401). The source is its own
 * process, built on the official SDK (fixtures/eventSourceServer.mjs): it pushes
 * events over `events/stream`, answers `events/poll`, and sends Claude channel
 * messages and resource notifications. FLUJO reaches it only through its real
 * connection code (the MCP service, both transports) and the real scheduler arms
 * the automations.
 *
 * The checks read what the user sees: the automation's run history and the note on
 * its card, the server's status, and the resource list version the capabilities view
 * polls. Then the server is killed and started again: FLUJO reconnects on its own,
 * replays what it missed from the saved cursor, runs nothing twice and keeps no stale
 * stream or note.
 *
 * Stand-ins: storage lives in memory, and the flow engine records the run it was
 * asked to start instead of calling a model.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MCPServerConfig } from '@/shared/types/mcp';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const store = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : defaultValue),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(value)));
  }),
  clearItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
}));
jest.mock('@/backend/services/mcp/config', () => {
  const state = { configs: [] as unknown[] };
  return {
    __configState: state,
    loadServerConfigs: jest.fn(async () => state.configs),
    saveConfig: jest.fn(async () => ({ success: true })),
  };
});
jest.mock('@/backend/services/mcp/runtimeHomeIsolation', () => ({
  resolveRuntimeHomeIsolation: jest.fn(async () => false),
}));
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(async () => ({ status: 'completed', messages: [], conversationId: 'event-run', sharedState: {} })),
}));
jest.mock('@/backend/services/flow', () => ({
  ...jest.requireActual('@/backend/services/flow'),
  flowService: { getFlow: jest.fn(async (id: string) => ({ id, name: 'Event flow', nodes: [], edges: [] })) },
}));
jest.mock('@/backend/services/statistics', () => ({
  ...jest.requireActual('@/backend/services/statistics'),
  recordStatisticsEvent: jest.fn(),
}));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/runtimeLock'),
  withPersonaRuntimeLock: async (_id: string, task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) =>
    task({ assertOwned: async () => undefined }),
}));

import { mcpService } from '@/backend/services/mcp';
import * as configModule from '@/backend/services/mcp/config';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { SchedulerService } from '@/backend/services/scheduler';
import { loadRunRecords } from '@/backend/services/scheduler/runHistory';

jest.setTimeout(120_000);

const FIXTURE = path.join(__dirname, 'fixtures', 'eventSourceServer.mjs');

interface SourceState {
  pid: number;
  streams: number;
  connections: number;
  standaloneStreams: number;
  subscriptions: string[];
  streamRequests: Array<{ cursor: string | null; pid: number }>;
  polls: Array<{ cursor: string | null }>;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The outside server, seen from the test: its control port, its history file. */
class EventSource {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-event-source-'));
  private child?: ChildProcess;
  private port = 0;

  announced(): { pid: number; port: number } | null {
    const file = path.join(this.dir, 'control.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }

  /** Streamable HTTP: the test starts the server itself, as an independent process. */
  async startHttp(): Promise<string> {
    const before = this.announced()?.pid;
    this.child = spawn(process.execPath, [FIXTURE, this.dir, String(this.port)], { stdio: 'ignore' });
    const announced = await waitFor('the HTTP server to listen', () => {
      const current = this.announced();
      return current && current.pid !== before && current.pid === this.child?.pid ? current : null;
    });
    this.port = announced.port;
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async request<T>(route: string, body?: unknown): Promise<T> {
    const announced = this.announced();
    if (!announced) throw new Error('The event source is not running');
    const response = await fetch(`http://127.0.0.1:${announced.port}${route}`, body === undefined
      ? undefined
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return response.json() as Promise<T>;
  }

  state(): Promise<SourceState> {
    return this.request<SourceState>('/state');
  }

  emit(text: string): Promise<{ eventId: string; cursor: string }> {
    return this.request('/emit', { data: { text } });
  }

  /** An event that happened upstream while the server was down. */
  recordWhileDown(text: string): void {
    const history = path.join(this.dir, 'history.jsonl');
    const count = fs.existsSync(history) ? fs.readFileSync(history, 'utf8').split('\n').filter(Boolean).length : 0;
    fs.appendFileSync(history, `${JSON.stringify({
      eventId: `evt-${count + 1}`, name: 'message.received', timestamp: new Date().toISOString(), data: { text },
    })}\n`);
  }

  async kill(): Promise<number> {
    const announced = this.announced();
    if (!announced) throw new Error('The event source is not running');
    process.kill(announced.pid);
    await waitFor('the server process to exit', () => !alive(announced.pid));
    return announced.pid;
  }

  dispose(): void {
    const announced = this.announced();
    if (announced && alive(announced.pid)) process.kill(announced.pid);
    if (this.child?.pid && alive(this.child.pid)) this.child.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function useServer(config: Record<string, unknown>): void {
  (configModule as unknown as { __configState: { configs: unknown[] } }).__configState.configs = [{
    disabled: false, rootPath: '', env: {}, _buildCommand: '', _installCommand: '', ...config,
  } as unknown as MCPServerConfig];
}

const runInputs = () => (runFlow as jest.Mock).mock.calls.map(([input]) => JSON.stringify(input));
/** Runs of one automation (told apart by its prompt) that carried this event. */
const runsWith = (execution: PlannedExecution, marker: string) =>
  runInputs().filter(input => input.includes(execution.prompt) && input.includes(marker)).length;

async function completedRuns(execution: PlannedExecution): Promise<number> {
  return (await loadRunRecords(execution.id)).filter(record => record.status === 'completed').length;
}

async function expectRunFor(execution: PlannedExecution, marker: string, total: number): Promise<void> {
  await waitFor(`a run of "${execution.prompt}" for "${marker}"`, () => runsWith(execution, marker) === 1);
  await waitFor(`${total} completed runs in the history`, async () => (await completedRuns(execution)) === total);
}

describe('a real event source process', () => {
  let scheduler: SchedulerService;
  let source: EventSource;

  beforeEach(() => {
    store.clear();
    (runFlow as jest.Mock).mockClear();
    scheduler = new SchedulerService();
    source = new EventSource();
  });

  afterEach(async () => {
    try {
      await scheduler.setPaused(true);
      await mcpService.disconnectServer('event-source');
    } finally {
      source.dispose();
    }
  });

  const create = async (trigger: Record<string, unknown>, prompt: string) => {
    const { execution, error } = await scheduler.create({
      name: prompt,
      enabled: true,
      flowId: 'flow-1',
      prompt,
      trigger: { type: 'mcp-event', serverName: 'event-source', eventName: 'message.received', secret: '', ...trigger },
    } as never);
    if (!execution) throw new Error(error ?? 'The automation was not created');
    return execution;
  };
  const note = (execution: PlannedExecution) => scheduler.getStatus(execution).lastTriggerError;

  it('stdio: pushes events, channel messages and resource changes, and recovers when the server is killed', async () => {
    useServer({ name: 'event-source', transport: 'stdio', command: process.execPath, args: [FIXTURE, source.dir], rootPath: source.dir });

    const push = await create({ delivery: 'push' }, 'React to the event');
    const channel = await create({ source: 'claude-channel', eventName: '' }, 'React to the channel message');
    await waitFor('the push stream to open', async () => (await source.state()).streams === 1);
    const firstPid = source.announced()!.pid;
    expect((await source.state()).streamRequests).toEqual([{ cursor: null, pid: firstPid }]);

    await source.emit('stdio-push-1');
    await expectRunFor(push, 'stdio-push-1', 1);

    await source.request('/channel', { content: 'stdio-channel-1', meta: { message_id: 'm1' } });
    await expectRunFor(channel, 'stdio-channel-1', 1);

    const versionBefore = mcpService.getResourceListVersion('event-source');
    await source.request('/resources-changed', {});
    await waitFor('the resource list version to move', () => mcpService.getResourceListVersion('event-source') > versionBefore);

    // The server dies. An event happens upstream while it is gone.
    await source.kill();
    source.recordWhileDown('stdio-missed-while-down');

    // FLUJO starts it again on its own and resumes from the saved cursor.
    const restarted = await waitFor('a new server process', () => {
      const current = source.announced();
      return current && current.pid !== firstPid && alive(current.pid) ? current : null;
    });
    await expectRunFor(push, 'stdio-missed-while-down', 2);
    const state = await source.state();
    expect(state.pid).toBe(restarted.pid);
    expect(state.streams).toBe(1);
    expect(state.streamRequests).toEqual([{ cursor: 'pos-1', pid: restarted.pid }]);
    expect((await mcpService.getServerStatus('event-source')).status).toBe('connected');

    await source.emit('stdio-push-2');
    await expectRunFor(push, 'stdio-push-2', 3);
    await source.request('/channel', { content: 'stdio-channel-2', meta: { message_id: 'm2' } });
    await expectRunFor(channel, 'stdio-channel-2', 2);
    const versionAfter = mcpService.getResourceListVersion('event-source');
    await source.request('/resources-changed', {});
    await waitFor('the resource list version to move after the restart', () => mcpService.getResourceListVersion('event-source') > versionAfter);

    await waitFor('the push card note to clear', () => note(push) === undefined);
    await waitFor('the channel card note to clear', () => note(channel) === undefined);
    for (const marker of ['stdio-push-1', 'stdio-missed-while-down', 'stdio-push-2']) expect(runsWith(push, marker)).toBe(1);
    for (const marker of ['stdio-channel-1', 'stdio-channel-2']) expect(runsWith(channel, marker)).toBe(1);
    expect(await completedRuns(push)).toBe(3);
    expect(await completedRuns(channel)).toBe(2);

    // Switching the automation off ends its stream on the server.
    await scheduler.update(push.id, { enabled: false });
    await waitFor('the stream to be cancelled', async () => (await source.state()).streams === 0);
  });

  it('Streamable HTTP: push and poll survive the server going away and coming back on the same address', async () => {
    const serverUrl = await source.startHttp();
    useServer({ name: 'event-source', transport: 'streamable', serverUrl });

    const push = await create({ delivery: 'push' }, 'React to the pushed event');
    const poll = await create({ delivery: 'poll' }, 'React to the polled event');
    await waitFor('the push stream to open', async () => (await source.state()).streams === 1);
    await waitFor('the first poll', async () => (await source.state()).polls.length > 0);
    await waitFor('the notification stream to open', async () => (await source.state()).standaloneStreams > 0);

    await source.emit('http-1');
    await expectRunFor(push, 'http-1', 1);
    await expectRunFor(poll, 'http-1', 1);
    const versionBefore = mcpService.getResourceListVersion('event-source');
    await source.request('/resources-changed', {});
    await waitFor('the resource list version to move', () => mcpService.getResourceListVersion('event-source') > versionBefore);

    // The server goes away for a while; the card says so instead of hanging.
    await source.kill();
    await waitFor('a note on the push card', () => note(push));
    source.recordWhileDown('http-missed-while-down');

    await source.startHttp();
    await waitFor('the push stream to reopen', async () => (await source.state()).streams === 1, 60_000);
    await expectRunFor(push, 'http-missed-while-down', 2);
    await expectRunFor(poll, 'http-missed-while-down', 2);
    expect((await source.state()).streamRequests).toEqual([expect.objectContaining({ cursor: 'pos-1' })]);
    expect((await source.state()).polls[0]).toEqual({ cursor: 'pos-1' });

    await source.emit('http-2');
    await expectRunFor(push, 'http-2', 3);
    await expectRunFor(poll, 'http-2', 3);
    await waitFor('the notification stream to reopen', async () => (await source.state()).standaloneStreams > 0, 60_000);
    const versionAfter = mcpService.getResourceListVersion('event-source');
    await source.request('/resources-changed', {});
    await waitFor('the resource list version to move after the restart', () => mcpService.getResourceListVersion('event-source') > versionAfter);

    await waitFor('the push card note to clear', () => note(push) === undefined);
    await waitFor('the poll card note to clear', () => note(poll) === undefined);
    for (const execution of [push, poll]) {
      for (const marker of ['http-1', 'http-missed-while-down', 'http-2']) expect(runsWith(execution, marker)).toBe(1);
      expect(await completedRuns(execution)).toBe(3);
    }
  });

  it('stdio: a server that hangs without exiting is replaced', async () => {
    useServer({ name: 'event-source', transport: 'stdio', command: process.execPath, args: [FIXTURE, source.dir], rootPath: source.dir });

    const push = await create({ delivery: 'push' }, 'React to the event');
    await waitFor('the push stream to open', async () => (await source.state()).streams === 1);
    const hungPid = source.announced()!.pid;
    await source.emit('before-hang');
    await expectRunFor(push, 'before-hang', 1);

    // The server stops reading and goes silent, but its process stays up.
    await source.request('/hang', {});
    source.recordWhileDown('during-hang');

    const replacement = await waitFor('a new server process', () => {
      const current = source.announced();
      return current && current.pid !== hungPid ? current : null;
    }, 90_000);
    await waitFor('the hung process to be ended', () => !alive(hungPid));
    await expectRunFor(push, 'during-hang', 2);
    expect((await source.state()).streamRequests).toEqual([{ cursor: 'pos-1', pid: replacement.pid }]);

    await source.emit('after-hang');
    await expectRunFor(push, 'after-hang', 3);
    await waitFor('the push card note to clear', () => note(push) === undefined);
  });

  it('Streamable HTTP: notifications come back after a restart even when no request fails', async () => {
    const serverUrl = await source.startHttp();
    useServer({ name: 'event-source', transport: 'streamable', serverUrl });

    // Only notifications: no stream or poll request that could notice the restart.
    const channel = await create({ source: 'claude-channel', eventName: '' }, 'React to the channel message');
    await waitFor('the notification stream to open', async () => (await source.state()).standaloneStreams > 0);
    await source.request('/channel', { content: 'http-channel-1', meta: { message_id: 'm1' } });
    await expectRunFor(channel, 'http-channel-1', 1);

    await source.kill();
    await source.startHttp();

    // The SDK gives up on the old session's notification stream; FLUJO must reconnect.
    await waitFor('the notification stream to reopen on the new server', async () => (await source.state()).standaloneStreams > 0, 60_000);
    await source.request('/channel', { content: 'http-channel-2', meta: { message_id: 'm2' } });
    await expectRunFor(channel, 'http-channel-2', 2);
    const version = mcpService.getResourceListVersion('event-source');
    await source.request('/resources-changed', {});
    await waitFor('the resource list version to move after the restart', () => mcpService.getResourceListVersion('event-source') > version);
    expect((await mcpService.getServerStatus('event-source')).status).toBe('connected');
    await waitFor('the channel card note to clear', () => note(channel) === undefined);
  });
});
