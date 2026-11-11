/**
 * The "tool server reports an event" trigger: signature checks, the subscription
 * loop, and the delivery decisions that decide whether a sender keeps an event.
 */
import { createHmac } from 'crypto';
import {
  armMcpEvent,
  mcpEventDeliveryUrl,
  mcpEventFingerprint,
  newMcpEventSecret,
  verifyMcpEventSignature,
  type McpEventDeps,
} from '@/backend/services/scheduler/triggers/mcpEvent';
import {
  receiveMcpEvent,
  type McpEventDeliveryDeps,
  type McpEventDeliveryInput,
  type McpEventScheduler,
} from '@/backend/services/scheduler/mcpEventDelivery';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
} from '@/shared/types/plannedExecution';

const SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const NOW = 1_800_000_000_000;

function sign(id: string, timestamp: number, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

const trigger: McpEventTriggerConfig = {
  type: 'mcp-event', serverName: 'chat', eventName: 'message.received', arguments: { chat_ids: ['a'] }, secret: SECRET,
};

describe('verifyMcpEventSignature', () => {
  const body = '{"a":1}';
  const timestamp = NOW / 1000;
  const headers = { id: 'evt_1', timestamp: String(timestamp), signature: sign('evt_1', timestamp, body) };

  it('accepts a correct signature', () => {
    expect(verifyMcpEventSignature(SECRET, headers, body, NOW)).toBe(true);
  });
  it('accepts any listed signature, for key rotation', () => {
    expect(verifyMcpEventSignature(SECRET, { ...headers, signature: `v1,AAAA ${headers.signature}` }, body, NOW)).toBe(true);
  });
  it.each([
    ['changed body', { ...headers }, '{"a":2}', NOW],
    ['another id', { ...headers, id: 'evt_2' }, body, NOW],
    ['an old timestamp', { ...headers }, body, NOW + 301_000],
    ['a future timestamp', { ...headers }, body, NOW - 301_000],
    ['no signature', { ...headers, signature: null }, body, NOW],
    ['a malformed timestamp', { ...headers, timestamp: 'soon' }, body, NOW],
    ['another signature scheme', { ...headers, signature: 'v1a,AAAA' }, body, NOW],
  ])('refuses %s', (_name, input, payload, now) => {
    expect(verifyMcpEventSignature(SECRET, input, payload as string, now as number)).toBe(false);
  });
  it('refuses a signature made with another secret', () => {
    const other = newMcpEventSecret();
    expect(verifyMcpEventSignature(SECRET, { ...headers, signature: sign('evt_1', timestamp, body, other) }, body, NOW)).toBe(false);
  });
});

describe('delivery URL', () => {
  afterEach(() => { delete process.env.FLUJO_PORT; delete process.env.FLUJO_BASE_URL; });

  it('always points at this machine', () => {
    process.env.FLUJO_BASE_URL = 'https://flujo.example.com:8443';
    const url = new URL(mcpEventDeliveryUrl('id-1', trigger, 'default-workspace'));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('8443');
    expect(url.pathname).toBe('/api/webhooks/mcp/id-1');
    expect(url.searchParams.get('v')).toBe(mcpEventFingerprint(trigger));
    expect(url.searchParams.has('workspace')).toBe(false);
  });
  it('carries a non-default workspace and prefers FLUJO_PORT', () => {
    process.env.FLUJO_PORT = '4300';
    const url = new URL(mcpEventDeliveryUrl('id-1', trigger, 'team'));
    expect(url.port).toBe('4300');
    expect(url.searchParams.get('workspace')).toBe('team');
  });
  it('changes when the subscription changes', () => {
    expect(mcpEventFingerprint({ ...trigger, arguments: { chat_ids: ['b'] } })).not.toBe(mcpEventFingerprint(trigger));
  });
});

describe('armMcpEvent', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  function deps(overrides: Partial<McpEventDeps> = {}) {
    return {
      subscribe: jest.fn(async () => ({ refreshBefore: new Date(Date.now() + 7 * 86_400_000).toISOString() })),
      pin: jest.fn(), unpin: jest.fn(), onError: jest.fn(), onSuccess: jest.fn(),
      ...overrides,
    };
  }

  it('pins the server, subscribes and keeps refreshing', async () => {
    const d = deps();
    const armed = armMcpEvent(d);
    await flush();
    expect(d.pin).toHaveBeenCalledTimes(1);
    expect(d.subscribe).toHaveBeenCalledTimes(1);
    expect(d.onSuccess).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(d.subscribe).toHaveBeenCalledTimes(2);
    armed.dispose();
  });

  it('refreshes well before a short grant runs out', async () => {
    const d = deps({ subscribe: jest.fn(async () => ({ refreshBefore: new Date(Date.now() + 60_000).toISOString() })) });
    const armed = armMcpEvent(d);
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(d.subscribe).toHaveBeenCalledTimes(2);
    armed.dispose();
  });

  it('reports a failure, retries, and clears the error once it works', async () => {
    const subscribe = jest.fn()
      .mockRejectedValueOnce(new Error('server is starting'))
      .mockResolvedValue({ refreshBefore: null });
    const d = deps({ subscribe });
    const armed = armMcpEvent(d);
    await flush();
    expect(d.onError).toHaveBeenCalledWith('server is starting');
    expect(d.onSuccess).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(d.onSuccess).toHaveBeenCalledTimes(1);
    armed.dispose();
  });

  it('stops and unpins on dispose', async () => {
    const d = deps();
    const armed = armMcpEvent(d);
    await flush();
    armed.dispose();
    await flush();
    expect(d.unpin).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(d.subscribe).toHaveBeenCalledTimes(1);
  });
});

describe('receiveMcpEvent', () => {
  const execution = (overrides: Partial<PlannedExecution> = {}): PlannedExecution => ({
    id: 'exec-1', name: 'n', flowId: 'f', enabled: true, trigger, createdAt: 'c', updatedAt: 'u', ...overrides,
  } as PlannedExecution);

  function setup(current: PlannedExecution | null = execution()) {
    let state: PlannedExecutionState = {};
    const scheduler = {
      get: jest.fn(async () => current),
      isPaused: jest.fn(async (): Promise<boolean> => false),
      isRunning: jest.fn((): boolean => false),
      exclusiveGateFor: jest.fn((): 'queue' | 'skip' | 'error' | null => null),
      fire: jest.fn(async () => ({ status: 'completed' } as RunRecord)),
      admitPersonaFire: jest.fn(async () => ({ runId: 'run-p', completion: Promise.resolve() })),
    } satisfies McpEventScheduler;
    const deps: McpEventDeliveryDeps = {
      scheduler,
      loadState: async () => state,
      updateState: async (_id, update) => { state = update(state); },
      now: () => NOW,
    };
    return { scheduler, deps, getState: () => state };
  }

  function input(id = 'evt_1', overrides: Partial<McpEventDeliveryInput> = {}): McpEventDeliveryInput {
    const body = overrides.body ?? JSON.stringify({ eventId: id, name: 'message.received', timestamp: 't', data: { body: 'hi' } });
    const timestamp = NOW / 1000;
    return {
      id: 'exec-1', fingerprint: mcpEventFingerprint(trigger), webhookId: id, webhookTimestamp: String(timestamp),
      webhookSignature: sign(id, timestamp, body), body, ...overrides,
    };
  }

  it('starts a run with the event as data and remembers it', async () => {
    const { scheduler, deps, getState } = setup();
    const result = await receiveMcpEvent(deps, input());
    expect(result.status).toBe(202);
    expect(scheduler.fire).toHaveBeenCalledTimes(1);
    const payload = (scheduler.fire.mock.calls[0] as unknown[])[1] as { kind: string; context: { event: { data: unknown } } };
    expect(payload.kind).toBe('mcp-event');
    expect(payload.context.event.data).toEqual({ body: 'hi' });
    expect(getState().seenIds).toEqual(['evt_1']);
  });

  it('answers a repeated delivery without a second run', async () => {
    const { scheduler, deps } = setup();
    await receiveMcpEvent(deps, input());
    const again = await receiveMcpEvent(deps, input());
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(scheduler.fire).toHaveBeenCalledTimes(1);
  });

  it('asks the sender to wait while a run is going, and forgets nothing', async () => {
    const { scheduler, deps, getState } = setup();
    scheduler.isRunning.mockReturnValue(true);
    const busy = await receiveMcpEvent(deps, input());
    expect(busy.status).toBe(503);
    expect(busy.retryAfterSeconds).toBeGreaterThan(0);
    expect(scheduler.fire).not.toHaveBeenCalled();
    expect(getState().seenIds).toBeUndefined();
    scheduler.isRunning.mockReturnValue(false);
    expect((await receiveMcpEvent(deps, input())).status).toBe(202);
  });

  it('lets parallel automations overlap', async () => {
    const { scheduler, deps } = setup(execution({ overlapStrategy: 'parallel' }));
    scheduler.isRunning.mockReturnValue(true);
    expect((await receiveMcpEvent(deps, input())).status).toBe(202);
  });

  it('asks the sender to wait while paused or locked out', async () => {
    const { scheduler, deps } = setup();
    scheduler.isPaused.mockResolvedValue(true);
    expect((await receiveMcpEvent(deps, input())).status).toBe(503);
    scheduler.isPaused.mockResolvedValue(false);
    scheduler.exclusiveGateFor.mockReturnValue('skip');
    expect((await receiveMcpEvent(deps, input())).status).toBe(503);
    expect(scheduler.fire).not.toHaveBeenCalled();
  });

  it.each([
    ['a deleted automation', null],
    ['a disabled automation', execution({ enabled: false })],
    ['another trigger type', execution({ trigger: { type: 'webhook', token: 't' } })],
  ])('tells the sender to stop for %s', async (_name, current) => {
    const { scheduler, deps } = setup(current as PlannedExecution | null);
    expect((await receiveMcpEvent(deps, input())).status).toBe(410);
    expect(scheduler.fire).not.toHaveBeenCalled();
  });

  it('tells a subscription from an older configuration to stop', async () => {
    const { deps } = setup();
    expect((await receiveMcpEvent(deps, input('evt_1', { fingerprint: 'stale' }))).status).toBe(410);
  });

  it('refuses a bad signature and an oversized body', async () => {
    const { scheduler, deps } = setup();
    expect((await receiveMcpEvent(deps, input('evt_1', { webhookSignature: 'v1,AAAA' }))).status).toBe(401);
    expect((await receiveMcpEvent(deps, input('evt_1', { body: 'x'.repeat(256 * 1024 + 1) }))).status).toBe(413);
    expect(scheduler.fire).not.toHaveBeenCalled();
  });

  it('refuses a different event than the one subscribed', async () => {
    const { deps } = setup();
    const body = JSON.stringify({ name: 'other' });
    expect((await receiveMcpEvent(deps, input('evt_1', { body }))).status).toBe(400);
  });

  it('hands Persona automations to durable admission', async () => {
    const { scheduler, deps, getState } = setup(execution({ personaId: 'p1' } as Partial<PlannedExecution>));
    const result = await receiveMcpEvent(deps, input());
    expect(result.status).toBe(202);
    expect(scheduler.admitPersonaFire).toHaveBeenCalledTimes(1);
    expect(scheduler.fire).not.toHaveBeenCalled();
    expect(getState().seenIds).toEqual(['evt_1']);
  });

  it('keeps the event with the sender when a Persona cannot take it', async () => {
    const { scheduler, deps, getState } = setup(execution({ personaId: 'p1' } as Partial<PlannedExecution>));
    scheduler.admitPersonaFire.mockRejectedValueOnce(new Error('storage busy'));
    expect((await receiveMcpEvent(deps, input())).status).toBe(503);
    expect(getState().seenIds).toBeUndefined();
  });
});
