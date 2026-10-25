jest.mock('node:v8', () => ({ getHeapStatistics: jest.fn() }));

import { getHeapStatistics } from 'node:v8';
import { acquireFlowRunAdmission, getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import { SubflowPreparationBudget, getSubflowPreparationDiagnostics } from '@/backend/execution/flow/subflowPreparationBudget';
import { SubflowOutputBudget, getSubflowOutputDiagnostics } from '@/backend/execution/flow/subflowOutputBudget';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';

const MiB = 1024 ** 2;
function headroom(bytes: number): void {
  jest.mocked(getHeapStatistics).mockReturnValue({ heap_size_limit: 1024 * MiB,
    used_heap_size: 1024 * MiB * 0.8 - 64 * MiB - bytes } as ReturnType<typeof getHeapStatistics>);
}
beforeEach(() => {
  headroom(512 * MiB);
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 128 * MiB } as ReturnType<typeof process.memoryUsage>);
});
afterEach(() => {
  expect(getAllocationReservationSnapshot().total).toBe(0);
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
  expect(getSubflowPreparationDiagnostics().reservedBytes).toBe(0);
  expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  jest.restoreAllMocks();
});

it('keeps outstanding output visible to both Flow and preparation admission', () => {
  const output = new SubflowOutputBudget();
  const preparation = new SubflowPreparationBudget();
  try {
    output.reserve(128 * MiB);
    headroom(128 * MiB);
    expect(() => acquireFlowRunAdmission({})).toThrow(expect.objectContaining({ code: 'FLOW_RUN_MEMORY' }));
    expect(() => preparation.reserve(MiB)).toThrow(expect.objectContaining({ code: 'SUBFLOW_PREPARATION_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ output: 128 * MiB, run: 0, preparation: 0 });
  } finally { preparation.release(); output.release(); }
});

it('refuses output before publication when other components already own the remaining headroom', () => {
  const run = acquireFlowRunAdmission({});
  const preparation = new SubflowPreparationBudget();
  const output = new SubflowOutputBudget();
  try {
    preparation.reserve(MiB);
    headroom(2 * MiB);
    expect(() => output.reserve(4096)).toThrow(expect.objectContaining({ code: 'SUBFLOW_OUTPUT_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ run: MiB, preparation: MiB, output: 0 });
  } finally { output.release(); preparation.release(); run.release(); }
});

it('replaces an existing output reservation without double counting or publishing a refused growth', () => {
  const output = new SubflowOutputBudget();
  const preparation = new SubflowPreparationBudget();
  try {
    preparation.reserve(MiB);
    output.reserve(MiB);
    headroom(3 * MiB);
    output.reserve(2 * MiB);
    expect(getAllocationReservationSnapshot().total).toBe(3 * MiB);
    expect(() => output.reserve(3 * MiB)).toThrow(expect.objectContaining({ code: 'SUBFLOW_OUTPUT_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ output: 2 * MiB, preparation: MiB, total: 3 * MiB });
  } finally { preparation.release(); output.release(); }
});

it('preserves observed output across a helper bundle reload and releases the original owner naturally', () => {
  const output = new SubflowOutputBudget();
  try {
    output.reserve(MiB);
    jest.isolateModules(() => {
      const reloaded = require('@/backend/execution/flow/allocationReservations') as typeof import('@/backend/execution/flow/allocationReservations');
      const snapshot = reloaded.getAllocationReservationSnapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot).toMatchObject({ output: MiB, total: MiB });
    });
  } finally { output.release(); }
  expect(getAllocationReservationSnapshot().output).toBe(0);
});
