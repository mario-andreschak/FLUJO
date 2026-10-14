import {
  bindExecutionModelStepOrdinals,
  takeExecutionModelStepOrdinal,
} from '@/backend/execution/flow/modelStepOrdinals';
import type { SharedState } from '@/backend/execution/flow/types';
import { MAX_EXECUTION_MODEL_STEP_ORDINAL } from '@/backend/execution/extensions';

const state = (logicalRunId?: string): SharedState => ({ logicalRunId }) as SharedState;

it('keeps per-node cursors on a same-run resume and resets only for a new run id', () => {
  const runState = state('run-a');
  bindExecutionModelStepOrdinals(runState, undefined);
  expect(takeExecutionModelStepOrdinal(runState, 'proc-a', 'run-a')).toBe(0);
  expect(takeExecutionModelStepOrdinal(runState, 'proc-b', 'run-a')).toBe(0);

  const reloaded = JSON.parse(JSON.stringify(runState)) as SharedState;
  bindExecutionModelStepOrdinals(reloaded, 'run-a');
  expect(takeExecutionModelStepOrdinal(reloaded, 'proc-a', 'run-a')).toBe(1);
  expect(takeExecutionModelStepOrdinal(reloaded, 'proc-b', 'run-a')).toBe(1);

  // Reusing the same id cannot silently recreate ordinal zero.
  bindExecutionModelStepOrdinals(reloaded, 'run-a');
  expect(takeExecutionModelStepOrdinal(reloaded, 'proc-a', 'run-a')).toBe(2);
  reloaded.logicalRunId = 'run-b';
  bindExecutionModelStepOrdinals(reloaded, 'run-a');
  expect(takeExecutionModelStepOrdinal(reloaded, 'proc-a', 'run-b')).toBe(0);
});

it('fails closed on a missing or malformed same-run boundary', () => {
  expect(() => bindExecutionModelStepOrdinals(state(), undefined))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_required' }));

  const missing = state('run-a');
  expect(() => bindExecutionModelStepOrdinals(missing, 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));

  const malformed = state('run-a');
  malformed.executionModelStepOrdinals = { logicalRunId: 'run-a', nextByNode: { 'proc-a': -1 } };
  expect(() => bindExecutionModelStepOrdinals(malformed, 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));

  const wrongRun = state('run-a');
  bindExecutionModelStepOrdinals(wrongRun, undefined);
  wrongRun.logicalRunId = 'run-b';
  expect(() => takeExecutionModelStepOrdinal(wrongRun, 'proc-a', 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
});

it('refuses accessor cursors without invoking a getter or issuing a reusable ordinal', () => {
  const runState = state('run-a');
  bindExecutionModelStepOrdinals(runState, undefined);
  const get = jest.fn(() => 0);
  const set = jest.fn();
  Object.defineProperty(runState.executionModelStepOrdinals!.nextByNode, 'proc-a', {
    get, set, enumerable: true,
  });

  expect(() => takeExecutionModelStepOrdinal(runState, 'proc-a', 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

it('refuses hidden cursors that would disappear from a persisted resume', () => {
  const runState = state('run-a');
  bindExecutionModelStepOrdinals(runState, undefined);
  Object.defineProperty(runState.executionModelStepOrdinals!.nextByNode, 'proc-a', {
    value: 4, writable: true, enumerable: false,
  });

  expect(() => takeExecutionModelStepOrdinal(runState, 'proc-a', 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
});

it('refuses proxy and getter-backed cursor records without consulting them', () => {
  const runState = state('run-a');
  bindExecutionModelStepOrdinals(runState, undefined);
  const get = jest.fn(() => 0);
  runState.executionModelStepOrdinals!.nextByNode = new Proxy({ 'proc-a': 0 }, { get });
  expect(() => takeExecutionModelStepOrdinal(runState, 'proc-a', 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
  expect(get).not.toHaveBeenCalled();

  const record = runState.executionModelStepOrdinals;
  const getRecord = jest.fn(() => record);
  Object.defineProperty(runState, 'executionModelStepOrdinals', { get: getRecord });
  expect(() => bindExecutionModelStepOrdinals(runState, 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
  expect(getRecord).not.toHaveBeenCalled();
});

it('refuses a hidden run marker or an unpersistable cursor key', () => {
  const runState = state('run-a');
  bindExecutionModelStepOrdinals(runState, undefined);
  Object.defineProperty(runState.executionModelStepOrdinals!, 'logicalRunId', { enumerable: false });
  expect(() => bindExecutionModelStepOrdinals(runState, 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));

  bindExecutionModelStepOrdinals(runState, undefined);
  Object.defineProperty(runState.executionModelStepOrdinals!.nextByNode, Symbol('proc-a'), {
    value: 1, writable: true, enumerable: true,
  });
  expect(() => bindExecutionModelStepOrdinals(runState, 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_run_state_invalid' }));
});

it('accepts serialized null-prototype cursors and preserves exhausted slots on resume', () => {
  const runState = state('run-a');
  runState.executionModelStepOrdinals = {
    logicalRunId: 'run-a', nextByNode: Object.assign(Object.create(null), {
      'proc-a': MAX_EXECUTION_MODEL_STEP_ORDINAL,
    }),
  };
  bindExecutionModelStepOrdinals(runState, 'run-a');
  expect(takeExecutionModelStepOrdinal(runState, 'proc-a', 'run-a')).toBe(MAX_EXECUTION_MODEL_STEP_ORDINAL);

  const reloaded = JSON.parse(JSON.stringify(runState)) as SharedState;
  bindExecutionModelStepOrdinals(reloaded, 'run-a');
  expect(() => takeExecutionModelStepOrdinal(reloaded, 'proc-a', 'run-a'))
    .toThrow(expect.objectContaining({ code: 'execution_model_step_slot_exhausted' }));
  expect(takeExecutionModelStepOrdinal(reloaded, 'constructor', 'run-a')).toBe(0);
  expect(takeExecutionModelStepOrdinal(reloaded, 'constructor', 'run-a')).toBe(1);
});
