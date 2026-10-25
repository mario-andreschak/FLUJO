jest.mock('node:v8', () => ({ getHeapStatistics: jest.fn() }));
import { getHeapStatistics } from 'node:v8';
import { acquireChatIngress, getChatIngressDiagnostics } from '@/utils/http/chatIngress';
import { acquireFlowRunAdmission, getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import { getSubflowPreparationDiagnostics, SubflowPreparationBudget } from '@/backend/execution/flow/subflowPreparationBudget';
import { getSubflowOutputDiagnostics, SubflowOutputBudget } from '@/backend/execution/flow/subflowOutputBudget';
import { getAllocationReservationSnapshot } from '@/backend/execution/flow/allocationReservations';
const MiB = 1024 ** 2;
function headroom(bytes: number) {
  jest.mocked(getHeapStatistics).mockReturnValue({ heap_size_limit: 1024 * MiB,
    used_heap_size: 1024 * MiB * 0.8 - 64 * MiB - bytes } as ReturnType<typeof getHeapStatistics>);
}
beforeEach(() => {
  headroom(512 * MiB);
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 128 * MiB } as ReturnType<typeof process.memoryUsage>);
});
afterEach(() => {
  expect(getAllocationReservationSnapshot().total).toBe(0);
  expect(getChatIngressDiagnostics().active).toBe(0);
  expect(getFlowRunAdmissionDiagnostics().activeRuns).toBe(0);
  expect(getSubflowPreparationDiagnostics().reservedBytes).toBe(0);
  expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  jest.restoreAllMocks();
});
it('keeps held input charged when output checks headroom, and admits output after input settles', () => {
  const input = acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() });
  const output = new SubflowOutputBudget();
  try {
    headroom(96 * MiB);
    expect(() => output.reserve(MiB)).toThrow(expect.objectContaining({ code: 'SUBFLOW_OUTPUT_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ ingress: 96 * MiB, output: 0 });
    expect(getChatIngressDiagnostics().active).toBe(1);
    input.release();
    output.reserve(MiB);
    expect(getAllocationReservationSnapshot()).toMatchObject({ ingress: 0, output: MiB });
  } finally { input.release(); output.release(); }
});
it('keeps held output charged when input checks headroom, and admits input after output settles', () => {
  const output = new SubflowOutputBudget(); output.reserve(MiB);
  let input: ReturnType<typeof acquireChatIngress> | undefined;
  try {
    headroom(96 * MiB);
    expect(() => acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() }))
      .toThrow(expect.objectContaining({ code: 'CHAT_INPUT_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ output: MiB, ingress: 0 });
    expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 1, reservedBytes: MiB });
    output.release();
    input = acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() });
    expect(getAllocationReservationSnapshot()).toMatchObject({ output: 0, ingress: 96 * MiB });
  } finally { input?.release(); output.release(); }
});
it('observes all four live owners and drains only each settling owner', () => {
  const input = acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() });
  const run = acquireFlowRunAdmission({});
  const prep = new SubflowPreparationBudget();
  const output = new SubflowOutputBudget();
  try {
    prep.reserve(MiB); output.reserve(MiB);
    expect(getAllocationReservationSnapshot()).toEqual({ ingress: 96 * MiB, run: MiB, preparation: MiB, output: MiB, publication: 0, total: 99 * MiB });
    run.release();
    expect(getAllocationReservationSnapshot()).toMatchObject({ run: 0, total: 98 * MiB });
    prep.release();
    expect(getAllocationReservationSnapshot()).toMatchObject({ preparation: 0, total: 97 * MiB });
    input.release();
    expect(getAllocationReservationSnapshot()).toMatchObject({ ingress: 0, output: MiB, total: MiB });
    output.release();
    expect(getAllocationReservationSnapshot().total).toBe(0);
  } finally { input.release(); run.release(); prep.release(); output.release(); }
});
it('charges input while run and preparation check remaining allocation headroom', () => {
  const input = acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() });
  const prep = new SubflowPreparationBudget();
  try {
    expect(getAllocationReservationSnapshot().ingress).toBe(96 * MiB);
    headroom(96 * MiB);
    expect(() => acquireFlowRunAdmission({})).toThrow(expect.objectContaining({ code: 'FLOW_RUN_MEMORY' }));
    expect(() => prep.reserve(MiB)).toThrow(expect.objectContaining({ code: 'SUBFLOW_PREPARATION_MEMORY' }));
    expect(getAllocationReservationSnapshot()).toMatchObject({ ingress: 96 * MiB, run: 0, preparation: 0 });
  } finally { input.release(); prep.release(); }
});
it('charges run and preparation while input checks headroom, and releases all observations naturally', () => {
  const run = acquireFlowRunAdmission({});
  const prep = new SubflowPreparationBudget(); prep.reserve(MiB);
  try {
    expect(getAllocationReservationSnapshot()).toMatchObject({ run: MiB, preparation: MiB });
    headroom(97 * MiB);
    expect(() => acquireChatIngress({ method: 'POST', url: 'http://localhost', headers: new Headers() }))
      .toThrow(expect.objectContaining({ code: 'CHAT_INPUT_MEMORY' }));
  } finally { run.release(); prep.release(); }
});
