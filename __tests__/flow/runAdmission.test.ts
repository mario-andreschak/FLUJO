jest.mock('node:v8', () => ({ getHeapStatistics: jest.fn() }));

import { getHeapStatistics } from 'node:v8';
import {
  acquireFlowRunAdmission,
  claimFlowRunAdmission,
  FlowRunPressureError,
  getFlowRunAdmissionDiagnostics,
  isFlowRunPressureError,
  recheckFlowRunAdmission,
  withFlowRunAdmission,
  type FlowRunAdmissionInput,
  type FlowRunAdmissionPermit,
} from '@/backend/execution/flow/runAdmission';
import { runWithWorkspace } from '@/utils/workspace';

const MiB = 1024 * 1024;
const ENV = ['MAX_PROCESS_RUNS', 'MAX_WORKSPACE_RUNS', 'MAX_CONVERSATION_RUNS',
  'MAX_PROCESS_BYTES', 'MAX_WORKSPACE_BYTES', 'MAX_INPUT_BYTES', 'MAX_RSS_BYTES']
  .map(name => `FLUJO_RUN_ADMISSION_${name}`);
let previousEnv: Array<string | undefined>;
let owned: FlowRunAdmissionPermit[];

function acquire(input: FlowRunAdmissionInput = {}): FlowRunAdmissionPermit {
  const permit = acquireFlowRunAdmission(input);
  owned.push(permit);
  return permit;
}
function claim(input: FlowRunAdmissionInput = {}): FlowRunAdmissionPermit {
  const permit = claimFlowRunAdmission(input);
  owned.push(permit);
  return permit;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function heap(used = 256 * MiB, limit = 4096 * MiB) {
  jest.mocked(getHeapStatistics).mockReturnValue({ used_heap_size: used, heap_size_limit: limit } as ReturnType<typeof getHeapStatistics>);
}

beforeEach(() => {
  previousEnv = ENV.map(key => process.env[key]);
  ENV.forEach(key => { delete process.env[key]; });
  owned = [];
  heap();
  const memory = process.memoryUsage();
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ ...memory, rss: 256 * MiB });
});
afterEach(() => {
  owned.forEach(permit => permit.release());
  expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 0, reservedBytes: 0, activeWorkspaces: 0 });
  ENV.forEach((key, index) => {
    if (previousEnv[index] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[index];
  });
  jest.restoreAllMocks();
});

it('immediately refuses a fifth queued conversation run and admits again after release', () => {
  const input = { conversationId: 'private-conversation', prompt: 'private-prompt' };
  const permits = Array.from({ length: 4 }, () => acquire(input));
  expect(() => acquire(input)).toThrow(expect.objectContaining({ code: 'FLOW_RUN_BUSY', status: 429, retryAfterSeconds: 5 }));
  expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 4, reservedBytes: 4 * MiB, workspaceConversations: 1 });
  permits[0].release();
  permits[0].release();
  acquire(input);
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(4);
  expect(JSON.stringify(getFlowRunAdmissionDiagnostics())).not.toMatch(/private-conversation|private-prompt/);
});

it('combines process capacity across workspaces while keeping conversation/workspace counts separate', () => {
  process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_RUNS = '3';
  process.env.FLUJO_RUN_ADMISSION_MAX_WORKSPACE_RUNS = '2';
  process.env.FLUJO_RUN_ADMISSION_MAX_CONVERSATION_RUNS = '1';
  runWithWorkspace('admission-a', () => {
    acquire({ conversationId: 'same' });
    acquire({ conversationId: 'other' });
    expect(() => acquire({ conversationId: 'third' })).toThrow(FlowRunPressureError);
  });
  runWithWorkspace('admission-b', () => {
    acquire({ conversationId: 'same' });
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 3, activeWorkspaces: 2, workspaceActiveRuns: 1 });
    expect(() => acquire({ conversationId: 'other' })).toThrow(FlowRunPressureError);
  });
});

it.each(['MAX_PROCESS_BYTES', 'MAX_WORKSPACE_BYTES'])('reserves queued bytes against %s before accepting another input', name => {
  process.env[`FLUJO_RUN_ADMISSION_${name}`] = String(2 * MiB);
  const first = acquire();
  acquire();
  expect(() => acquire()).toThrow(expect.objectContaining({ code: 'FLOW_RUN_MEMORY', status: 503 }));
  expect(getFlowRunAdmissionDiagnostics().reservedBytes).toBe(2 * MiB);
  first.release();
  acquire();
});

it('accounts for base64 media, tool arguments and definitions without serializing or copying them', () => {
  const media = 'M'.repeat(350_000);
  const input = { messages: [{ content: [{ type: 'image_url', image_url: { url: media } }],
    tool_calls: [{ function: { arguments: 'A'.repeat(50_000) } }] }], flowDefinition: { prompt: 'F'.repeat(50_000) } };
  const stringify = jest.spyOn(JSON, 'stringify');
  acquire(input);
  expect(getFlowRunAdmissionDiagnostics().reservedBytes).toBeGreaterThanOrEqual(4 * 2 * 450_000);
  expect(stringify).not.toHaveBeenCalled();
  expect(input.messages[0].content[0].image_url.url).toBe(media);
});

it('counts aliased data and the complete shared binary backing store once per input', () => {
  const backing = new ArrayBuffer(2 * MiB);
  const payload = { binary: new Uint8Array(backing, 0, 1), second: new DataView(backing, 1, 1) };
  acquire({ variables: { first: payload, second: payload } });
  expect(getFlowRunAdmissionDiagnostics().reservedBytes).toBeGreaterThanOrEqual(8 * MiB);
  expect(getFlowRunAdmissionDiagnostics().reservedBytes).toBeLessThan(9 * MiB);
});

it('rejects oversized inputs and bounded-walk uncertainty without allocating a reservation', () => {
  process.env.FLUJO_RUN_ADMISSION_MAX_INPUT_BYTES = '1024';
  expect(() => acquire({ prompt: 'X'.repeat(1024) })).toThrow(expect.objectContaining({ code: 'FLOW_RUN_INPUT_TOO_LARGE' }));
  delete process.env.FLUJO_RUN_ADMISSION_MAX_INPUT_BYTES;
  expect(() => acquire({ messages: new Array(100_001) })).toThrow(FlowRunPressureError);
  let deep: unknown = {};
  for (let index = 0; index < 66; index++) deep = { next: deep };
  expect(() => acquire({ variables: deep })).toThrow(FlowRunPressureError);
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
});

it('does not invoke accessors, proxies or JSON hooks while estimating data', () => {
  const getter = jest.fn(() => 'secret');
  const hook = jest.fn(() => 'secret');
  const trap = jest.fn(() => { throw new Error('proxy executed'); });
  const variables = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  expect(() => acquire({ variables })).toThrow(FlowRunPressureError);
  expect(() => acquire({ variables: { toJSON: hook } })).toThrow(FlowRunPressureError);
  expect(() => acquire({ variables: new Proxy({}, { ownKeys: trap, getPrototypeOf: trap }) })).toThrow(FlowRunPressureError);
  expect(getter).not.toHaveBeenCalled();
  expect(hook).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it('excludes runtime capabilities only at the input boundary', () => {
  const getter = jest.fn(() => { throw new Error('authority traversal'); });
  const input = Object.defineProperty({ prompt: 'small' }, 'executionAuthority', { enumerable: true, get: getter });
  acquire(input);
  expect(getter).not.toHaveBeenCalled();
  expect(() => acquire({ variables: { executionAuthority: new Proxy({}, {}) } })).toThrow(FlowRunPressureError);
});

it.each(['heap', 'rss'] as const)('refuses measured %s pressure and can retry after pressure subsides', kind => {
  if (kind === 'heap') heap(3300 * MiB);
  else jest.mocked(process.memoryUsage).mockReturnValue({ ...process.memoryUsage(), rss: 2048 * MiB });
  expect(() => acquire()).toThrow(expect.objectContaining({ code: 'FLOW_RUN_MEMORY' }));
  heap();
  jest.mocked(process.memoryUsage).mockReturnValue({ ...process.memoryUsage(), rss: 256 * MiB });
  acquire();
});

it('falls back to defaults for unsafe, zero, fractional and invalid configuration', () => {
  process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_RUNS = '0';
  process.env.FLUJO_RUN_ADMISSION_MAX_WORKSPACE_RUNS = '1.5';
  process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES = 'Infinity';
  process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = '-1';
  expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ maxProcessRuns: 64, maxWorkspaceRuns: 32,
    maxProcessBytes: 512 * MiB, maxRssBytes: 2048 * MiB });
});

it('holds a preflight during setup/queued execution and releases only after actual settlement', async () => {
  const input = { conversationId: 'queued' };
  const permit = acquire(input);
  const queue = deferred();
  const done = withFlowRunAdmission(permit, async () => {
    expect(claim(input)).toBe(permit);
    await queue.promise;
    return 'done';
  });
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
  queue.resolve();
  await expect(done).resolves.toBe('done');
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
});

it.each([false, true])('cleans up setup failure with claimed=%s', async claimed => {
  const permit = acquire();
  const error = new Error('setup failed');
  await expect(withFlowRunAdmission(permit, async () => {
    if (claimed) expect(claim()).toBe(permit);
    throw error;
  })).rejects.toBe(error);
  permit.release();
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
});

it('does not release live work merely because its AbortSignal was cancelled', async () => {
  const controller = new AbortController();
  const input = { prompt: 'run', abortSignal: controller.signal };
  const permit = acquire(input);
  const drain = deferred();
  const done = withFlowRunAdmission(permit, async () => { claim(input); await drain.promise; });
  controller.abort();
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
  drain.resolve();
  await done;
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
});

it('claims preflight once; a nested child must obtain fresh capacity without waiting', async () => {
  process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_RUNS = '1';
  const input = { conversationId: 'parent' };
  const permit = acquire(input);
  await withFlowRunAdmission(permit, async () => {
    expect(claim(input)).toBe(permit);
    expect(() => claim({ conversationId: 'child' })).toThrow(expect.objectContaining({ code: 'FLOW_RUN_BUSY' }));
    expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
  });
});

it('charges separately for a child while the parent reservation remains held', async () => {
  const input = { conversationId: 'parent' };
  const parent = acquire(input);
  await withFlowRunAdmission(parent, async () => {
    claim(input);
    const child = claim({ conversationId: 'child' });
    expect(child).not.toBe(parent);
    expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(2);
    child.release();
    expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(1);
  });
});

it('rejects forged, reused and wrong-workspace preflight scopes', async () => {
  await expect(withFlowRunAdmission({ release: jest.fn() }, async () => undefined)).rejects.toThrow('invalid');
  const permit = acquire({ conversationId: 'one' });
  await expect(runWithWorkspace('other-scope', () => withFlowRunAdmission(permit, async () => undefined))).rejects.toThrow('workspace mismatch');
  await withFlowRunAdmission(permit, async () => {
    expect(() => claim({ conversationId: 'two' })).toThrow('does not match');
    expect(() => runWithWorkspace('other-scope', () => claim({ conversationId: 'one' }))).toThrow('does not match');
    claim({ conversationId: 'one' });
  });
  await expect(withFlowRunAdmission(permit, async () => undefined)).rejects.toThrow('invalid');
});

it('rechecks actual payload and memory before consuming a preflight', async () => {
  process.env.FLUJO_RUN_ADMISSION_MAX_PROCESS_BYTES = String(2 * MiB);
  const permit = acquire({ conversationId: 'growth' });
  await withFlowRunAdmission(permit, async () => {
    expect(() => claim({ conversationId: 'growth', prompt: 'X'.repeat(300_000) })).toThrow(FlowRunPressureError);
    expect(getFlowRunAdmissionDiagnostics()).toMatchObject({ activeRuns: 1, reservedBytes: MiB });
    heap(3300 * MiB);
    expect(() => claim({ conversationId: 'growth' })).toThrow(FlowRunPressureError);
    heap();
    expect(claim({ conversationId: 'growth' })).toBe(permit);
  });
});

it('accounts for transformed input growth without lowering the original reservation', () => {
  const input = { conversationId: 'transform' };
  const permit = claim(input);
  recheckFlowRunAdmission(permit, { ...input, prompt: 'X'.repeat(200_000) });
  const grown = getFlowRunAdmissionDiagnostics().reservedBytes;
  expect(grown).toBeGreaterThan(MiB);
  recheckFlowRunAdmission(permit, input);
  expect(getFlowRunAdmissionDiagnostics().reservedBytes).toBe(grown);
  expect(() => recheckFlowRunAdmission(permit, { conversationId: 'different' })).toThrow('does not match');
  permit.release();
  expect(() => recheckFlowRunAdmission(permit, input)).toThrow('expired');
});

it('recognizes pressure failures without classifying ordinary errors as overload', () => {
  expect(isFlowRunPressureError(new FlowRunPressureError('FLOW_RUN_MEMORY'))).toBe(true);
  expect(isFlowRunPressureError(new Error('FLOW_RUN_MEMORY'))).toBe(false);
  expect(isFlowRunPressureError({ name: 'FlowRunPressureError', code: 'FLOW_RUN_MEMORY' })).toBe(false);
});
