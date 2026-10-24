import { flowService } from '@/frontend/services/flow';

const mockFetch = jest.fn(); const previousFetch = global.fetch;
const privateFlow = { id: 'private', name: 'Private', nodes: [], edges: [] };
const shared = { id: `team-flow:${'t'.repeat(43)}:${'r'.repeat(43)}`, name: 'Shared', nodes: [], edges: [] };
const reply = (value: unknown, unavailable = false) => ({ ok: true, status: 200,
  headers: { get: () => unavailable ? 'unavailable' : 'available' }, json: async () => value });
beforeEach(async () => {
  mockFetch.mockReset(); global.fetch = mockFetch;
  mockFetch.mockResolvedValueOnce(reply([])); await flowService.loadFlows({ refresh: true }); mockFetch.mockReset();
});
afterEach(() => { global.fetch = previousFetch; });

it('refreshes shared choices, excludes them from private caches, and fetches full graphs by ID', async () => {
  mockFetch.mockResolvedValueOnce(reply([privateFlow, shared]));
  expect(await flowService.loadFlows({ includeShared: true })).toEqual([privateFlow, shared]);
  expect(await flowService.loadFlows()).toEqual([privateFlow]); expect(mockFetch).toHaveBeenCalledTimes(1);
  mockFetch.mockResolvedValueOnce(reply({ ...shared, description: 'Full graph response' }));
  expect(await flowService.getFlow(shared.id)).toMatchObject({ description: 'Full graph response' });
  mockFetch.mockResolvedValueOnce(reply([privateFlow], true)); const status = jest.fn();
  expect(await flowService.loadFlows({ includeShared: true, onSharedUnavailable: status })).toEqual([privateFlow]);
  expect(status).toHaveBeenCalledWith(true);
  expect(mockFetch).toHaveBeenLastCalledWith('/api/flow?shared=1', { cache: 'no-store' });
});

it('rejects private mutations of shared catalogue entries before sending requests', async () => {
  expect((await flowService.addFlow(shared)).success).toBe(false);
  expect((await flowService.updateFlow(shared)).success).toBe(false);
  expect((await flowService.deleteFlow(shared.id)).success).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});
