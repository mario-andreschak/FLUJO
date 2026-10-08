/**
 * Issue #357: per-tool-call cancellation registry + signal combination.
 */
import {
  registerToolCall,
  releaseToolCall,
  cancelToolCall,
  cancelAllToolCalls,
  listInFlightToolCalls,
} from '@/backend/execution/flow/toolCancelRegistry';
import { combineAbortSignals } from '@/backend/execution/flow/combineAbortSignals';

describe('toolCancelRegistry', () => {
  afterEach(() => {
    cancelAllToolCalls('conv-1');
    cancelAllToolCalls('conv-2');
  });

  it('registers, lists and releases a call', () => {
    const controller = registerToolCall('conv-1', 'call-a');
    expect(listInFlightToolCalls('conv-1')).toEqual(['call-a']);
    expect(controller.signal.aborted).toBe(false);
    releaseToolCall('conv-1', 'call-a');
    expect(listInFlightToolCalls('conv-1')).toEqual([]);
  });

  it('cancels exactly one call and leaves siblings running', () => {
    const a = registerToolCall('conv-1', 'call-a');
    const b = registerToolCall('conv-1', 'call-b');
    expect(cancelToolCall('conv-1', 'call-a')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(listInFlightToolCalls('conv-1')).toEqual(['call-b']);
  });

  it('is a race-safe no-op for unknown / already finished calls', () => {
    expect(cancelToolCall('conv-1', 'nope')).toBe(false);
    const a = registerToolCall('conv-1', 'call-a');
    releaseToolCall('conv-1', 'call-a');
    expect(cancelToolCall('conv-1', 'call-a')).toBe(false);
    expect(a.signal.aborted).toBe(false);
  });

  it('never collides across scopes', () => {
    const a = registerToolCall('conv-1', 'same-id');
    const b = registerToolCall('conv-2', 'same-id');
    cancelToolCall('conv-1', 'same-id');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it('cancelAllToolCalls aborts every in-flight call of the scope', () => {
    const a = registerToolCall('conv-1', 'call-a');
    const b = registerToolCall('conv-1', 'call-b');
    expect(cancelAllToolCalls('conv-1')).toBe(2);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(listInFlightToolCalls('conv-1')).toEqual([]);
  });
});

describe('combineAbortSignals', () => {
  it('returns undefined when nothing is given', () => {
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  it('passes a single signal through unchanged', () => {
    const controller = new AbortController();
    expect(combineAbortSignals(undefined, controller.signal)).toBe(controller.signal);
  });

  it('aborts when either input aborts', () => {
    const outer = new AbortController();
    const perCall = new AbortController();
    const combined = combineAbortSignals(outer.signal, perCall.signal)!;
    expect(combined.aborted).toBe(false);
    perCall.abort(new Error('Tool call cancelled by user.'));
    expect(combined.aborted).toBe(true);
  });

  it('is already aborted when an input was aborted before combining', () => {
    const outer = new AbortController();
    outer.abort();
    const combined = combineAbortSignals(outer.signal, new AbortController().signal)!;
    expect(combined.aborted).toBe(true);
  });
});
