import {
  bindExecutionModelStepOrdinals,
  takeExecutionModelStepOrdinal,
} from '@/backend/execution/flow/modelStepOrdinals';
import type { SharedState } from '@/backend/execution/flow/types';

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
