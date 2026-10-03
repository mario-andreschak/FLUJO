import type { ExecutionEvent } from '@/shared/types/execution/events';
import { createExecutionStream, ExecutionStreamAdmission, EXECUTION_STREAM_LIMITS, type ExecutionStreamSession } from '@/backend/execution/flow/engine/executionStream';
import { parseExecutionStreamControl } from '@/shared/types/execution/streamControl';
const event = (seq: number, size = 1000) => ({ type: 'model:delta', messageId: 'draft', conversationId: 'queue', seq, timestamp: 1, delta: 'x'.repeat(size) }) as ExecutionEvent;
const readAll = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let text = ''; let bytes = 0;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; text += new TextDecoder().decode(chunk.value); }
  return { text, bytes };
};

it('bounds a non-reading consumer and preserves a reset frame before teardown', async () => {
  const release = jest.fn(); const unsubscribe = jest.fn();
  let session!: ExecutionStreamSession;
  const stream = createExecutionStream(new AbortController().signal, release, () => ({ nextSeq: 100 }), active => { session = active; active.onCleanup(unsubscribe); }, 4096);
  try {
  for (let seq = 0; seq < 100; seq++) session.send(event(seq), seq);
  const stoppedAtPressure = session.closed;
  session.close();
  const output = await readAll(stream);
  expect(output.bytes).toBeLessThanOrEqual(4096);
  expect(stoppedAtPressure).toBe(true);
  expect(release).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(output.text).toContain('event: flujo-stream-control');
  expect(output.text).toContain('"reason":"slow-consumer"');
  expect(output.text).toContain('"nextSeq":100');
  expect(output.text.match(/flujo-stream-control/g)).toHaveLength(1);
  } finally { session.close(); }
});

it('rejects oversized media before enqueuing it', async () => {
  let session!: ExecutionStreamSession;
  const release = jest.fn();
  const stream = createExecutionStream(new AbortController().signal, release, () => ({ nextSeq: 1 }), active => { session = active; });
  expect(session.send(event(0, 300000), 0)).toBe(false);
  const output = await readAll(stream);
  expect(output.text).toContain('"reason":"event-too-large"');
  expect(output.bytes).toBeLessThan(1024);
  expect(release).toHaveBeenCalledTimes(1);
});

it('releases admission once on abort, cancel, repeated close and throwing cleanup', async () => {
  const abort = new AbortController(); const release = jest.fn(); const finalCleanup = jest.fn();
  let session!: ExecutionStreamSession;
  const stream = createExecutionStream(abort.signal, release, () => ({ nextSeq: 0 }), active => { session = active; active.onCleanup(() => { throw new Error('cleanup failure'); }); active.onCleanup(finalCleanup); });
  abort.abort(); session.close();
  await stream.cancel();
  expect(release).toHaveBeenCalledTimes(1);
  expect(finalCleanup).toHaveBeenCalledTimes(1);
  expect(session.send(event(0), 0)).toBe(false);
});

it('never subscribes for an already-aborted request', async () => {
  const abort = new AbortController(); abort.abort(); const setup = jest.fn(); const release = jest.fn();
  await readAll(createExecutionStream(abort.signal, release, () => ({ nextSeq: 0 }), setup));
  expect(setup).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledTimes(1);
});

it('cleans up a subscription registered after cancellation during async replay', async () => {
  let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
  const release = jest.fn(); const unsubscribe = jest.fn();
  const stream = createExecutionStream(new AbortController().signal, release, () => ({ nextSeq: 0 }), async session => { await gate; session.onCleanup(unsubscribe); });
  await stream.cancel(); resume(); await gate; await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('limits active subscriptions and bounded replay reads independently, then reuses released capacity', () => {
  const admission = new ExecutionStreamAdmission({ ...EXECUTION_STREAM_LIMITS, maxProcess: 3, maxWorkspace: 2, maxConversation: 1, maxReplayReads: 1 });
  const one = admission.reserve('one')!;
  expect(admission.reserve('one')).toBeUndefined();
  const two = admission.reserve('two')!;
  expect(admission.reserve('three')).toBeUndefined();
  const read = admission.reserveReplay()!;
  expect(admission.reserveReplay()).toBeUndefined();
  read(); read(); expect(admission.diagnostics().replayReads).toBe(0);
  one(); one(); two();
  expect(admission.diagnostics()).toMatchObject({ active: 0, conversations: 0, workspaces: 0 });
  const again = admission.reserve('one')!; expect(again).toBeDefined(); again();
});

it('validates control frames without confusing them with execution events', () => {
  const valid = { version: 1, reason: 'replay-gap', recovery: 'reload-snapshot', nextSeq: 3, epoch: 'epoch-1' };
  expect(parseExecutionStreamControl(valid)).toEqual(valid);
  for (const invalid of [null, { ...valid, nextSeq: -1 }, { ...valid, nextSeq: NaN }, { ...valid, reason: 'run:done' }, { ...valid, epoch: 12 }, { ...valid, epoch: '<private>' }]) expect(parseExecutionStreamControl(invalid)).toBeUndefined();
});
