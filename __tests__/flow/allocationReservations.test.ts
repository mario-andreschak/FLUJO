jest.mock('node:v8', () => ({ getHeapStatistics: jest.fn() }));
import { getHeapStatistics } from 'node:v8';
import { acquireChatIngress, getChatIngressDiagnostics } from '@/utils/http/chatIngress';
import { acquireFlowRunAdmission, getFlowRunAdmissionDiagnostics } from '@/backend/execution/flow/runAdmission';
import { getSubflowPreparationDiagnostics, SubflowPreparationBudget } from '@/backend/execution/flow/subflowPreparationBudget';
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
  jest.restoreAllMocks();
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
