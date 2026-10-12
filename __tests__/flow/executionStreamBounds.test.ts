import type { ExecutionEvent } from '@/shared/types/execution/events';
import { createExecutionStream, ExecutionStreamAdmission, EXECUTION_STREAM_LIMITS, type ExecutionStreamSession } from '@/backend/execution/flow/engine/executionStream';

jest.mock('@/utils/workspace', () => {
  let workspace = 'alpha';
  return { getCurrentWorkspace: () => workspace, workspaceCacheKey: (id: string) => workspace + '\0' + id,
    setWorkspace: (value: string) => { workspace = value; } };
});
const setWorkspace = (value: string) => jest.requireMock('@/utils/workspace').setWorkspace(value);
const event = (delta: string, seq = 0): ExecutionEvent => ({ type: 'model:delta', delta, messageId: 'draft', conversationId: 'c', timestamp: 1, seq });
const drain = async (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  let bytes = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return { bytes, text };
    bytes += chunk.value.byteLength;
    text += new TextDecoder().decode(chunk.value);
  }
};
beforeEach(() => { setWorkspace('alpha'); });

it('rejects conversation, workspace and process overload without growing admission maps', () => {
  const admission = new ExecutionStreamAdmission({ ...EXECUTION_STREAM_LIMITS, maxProcess: 3, maxWorkspace: 2, maxConversation: 1 });
  const first = admission.reserve('c')!;
  expect(admission.reserve('c')).toBeUndefined();
  const second = admission.reserve('d')!;
  expect(admission.reserve('e')).toBeUndefined();
  setWorkspace('beta');
  const third = admission.reserve('c')!;
  expect(admission.reserve('new')).toBeUndefined();
  expect(admission.diagnostics()).toMatchObject({ active: 3, workspaces: 2, conversations: 3, rejected: 3 });
  first(); first(); second(); third();
  expect(admission.diagnostics()).toMatchObject({ active: 0, workspaces: 0, conversations: 0 });
});

it('keeps native replay admission finite with idempotent releases', () => {
  const admission = new ExecutionStreamAdmission({ ...EXECUTION_STREAM_LIMITS, maxReplayReads: 1 });
  const release = admission.reserveReplay()!;
  expect(admission.reserveReplay()).toBeUndefined();
  expect(admission.diagnostics().replayReads).toBe(1);
  release(); release();
  expect(admission.diagnostics().replayReads).toBe(0);
});

it('closes a slow consumer with a named recovery frame within its byte queue cap', async () => {
  let session!: ExecutionStreamSession;
  const release = jest.fn();
  const cleanup = jest.fn();
  const body = createExecutionStream(new AbortController().signal, release, () => ({ nextSeq: 20 }), active => {
    session = active; active.onCleanup(cleanup);
  }, 4096);
  for (let seq = 0; seq < 20; seq++) session.send(event('漢🙂'.repeat(120), seq), seq);
  const result = await drain(body);
  expect(result.bytes).toBeLessThanOrEqual(4096);
  expect(result.text).toContain('event: flujo-stream-control');
  expect(result.text).toContain('"reason":"slow-consumer"');
  expect(result.text).toContain('id:\nevent:');
  expect(session.closed).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});

it('rejects an oversized wire event before creating the full JSON string', async () => {
  let session!: ExecutionStreamSession;
  const body = createExecutionStream(new AbortController().signal, jest.fn(), () => ({ nextSeq: 1 }), active => { session = active; });
  const stringify = jest.spyOn(JSON, 'stringify');
  const tooLarge = event('x'.repeat(256 * 1024));
  try {
    expect(session.send(tooLarge, 0)).toBe(false);
    expect(stringify.mock.calls).toHaveLength(1);
    expect(stringify.mock.calls[0][0]).toMatchObject({ version: 1, reason: 'event-too-large' });
    const result = await drain(body);
    expect(result.text).toContain('"reason":"event-too-large"');
    expect(result.text).not.toContain('"messageId":"draft"');
  } finally { stringify.mockRestore(); }
});

it('body cancellation releases the stream immediately while native replay keeps its permit', async () => {
  const admission = new ExecutionStreamAdmission();
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  let lifetime!: AbortSignal;
  const body = createExecutionStream(new AbortController().signal, admission.reserve('c')!, () => ({ nextSeq: 0 }), async session => {
    lifetime = session.signal;
    const releaseReplay = admission.reserveReplay()!;
    try { await pending; } finally { releaseReplay(); }
  });
  await body.cancel();
  expect(lifetime.aborted).toBe(true);
  expect(admission.diagnostics()).toMatchObject({ active: 0, replayReads: 1 });
  complete();
  await pending;
  await Promise.resolve();
  expect(admission.diagnostics().replayReads).toBe(0);
});

it('handles an already-aborted request without subscribing or retaining admission', async () => {
  const abort = new AbortController(); abort.abort();
  const setup = jest.fn();
  const release = jest.fn();
  const body = createExecutionStream(abort.signal, release, () => ({ nextSeq: 0 }), setup);
  expect(await drain(body)).toEqual({ bytes: 0, text: '' });
  expect(setup).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('preserves event JSON and numeric IDs for an admitted stream', async () => {
  const value = event('hello');
  const body = createExecutionStream(new AbortController().signal, jest.fn(), () => ({ nextSeq: 1 }), session => {
    expect(session.send(value, value.seq)).toBe(true); session.close();
  });
  const result = await drain(body);
  expect(result.text).toContain('id: 0\ndata: ' + JSON.stringify(value));
  expect(result.text).not.toContain('flujo-stream-control');
});

it('turns setup failures into snapshot recovery without leaking a subscription', async () => {
  const cleanup = jest.fn();
  const release = jest.fn();
  const body = createExecutionStream(new AbortController().signal, release, () => ({ nextSeq: 0 }), session => {
    session.onCleanup(cleanup); throw new Error('replay unavailable');
  });
  expect((await drain(body)).text).toContain('"reason":"replay-gap"');
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
