import { FlowService } from '@/backend/services/flow';
import { listTeamFlows, resolveTeamFlow } from '@/backend/services/flow/teamCatalogue';
import { loadCollectionItem, saveCollectionItem, deleteCollectionItem } from '@/utils/storage/backend';
import type { Flow } from '@/shared/types/flow';

jest.mock('@/backend/services/flow/teamCatalogue', () => ({ ...jest.requireActual('@/backend/services/flow/teamCatalogue'),
  listTeamFlows: jest.fn(), resolveTeamFlow: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ ...jest.requireActual('@/utils/storage/backend'),
  loadCollectionItem: jest.fn(), saveCollectionItem: jest.fn(), deleteCollectionItem: jest.fn() }));
const privateFlow: Flow = { id: 'private', name: 'Private', nodes: [], edges: [] };
const shared: Flow = { id: `team-flow:${'t'.repeat(43)}:${'r'.repeat(43)}`, name: 'Team Flow', nodes: [], edges: [],
  teamFlow: { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), teamName: 'Team', version: 1, generation: 'a'.repeat(64) } };
let service: FlowService;
beforeEach(() => {
  jest.clearAllMocks(); service = new FlowService();
  global.__flujo_flowsCache = [privateFlow]; global.__flujo_flowsMigration = Promise.resolve();
  (listTeamFlows as jest.Mock).mockResolvedValue({ flows: [shared], unavailable: false });
  (resolveTeamFlow as jest.Mock).mockResolvedValue(shared);
});
afterEach(() => { global.__flujo_flowsCache = null; global.__flujo_flowsMigration = undefined; });

it('merges native catalogues while keeping mutations, copies and private storage separate', async () => {
  expect(await service.listFlows()).toMatchObject({ flows: [privateFlow, shared], sharedFlowsUnavailable: false });
  expect(await service.loadFlows()).toEqual([privateFlow]);
  (listTeamFlows as jest.Mock).mockClear();
  expect(await service.listFlows({ includeShared: false })).toMatchObject({ flows: [privateFlow] });
  expect(listTeamFlows).not.toHaveBeenCalled();
  expect((await service.saveFlow(shared)).success).toBe(false);
  expect((await service.saveFlow({ ...shared, id: 'forged-copy' })).success).toBe(false);
  expect((await service.deleteFlow(shared.id)).success).toBe(false);
  expect((await service.cloneFlowForPersona(shared.id, 'persona')).success).toBe(false);
  expect(saveCollectionItem).not.toHaveBeenCalled(); expect(deleteCollectionItem).not.toHaveBeenCalled();
});

it('resolves current snapshots and public IDs without private fallback after access ends', async () => {
  expect(await service.getFlowByName(shared.id)).toEqual(shared);
  expect((await service.readFlowExecutionSnapshot(shared.id))?.flow).toEqual(shared);
  (resolveTeamFlow as jest.Mock).mockRejectedValue(new Error('permission ended'));
  global.__flujo_flowsCache = [shared];
  await expect(service.getFlow(shared.id)).rejects.toThrow('permission ended');
  await expect(service.readFlowExecutionSnapshot(shared.id)).rejects.toThrow('permission ended');
  expect(loadCollectionItem).not.toHaveBeenCalled();
  (listTeamFlows as jest.Mock).mockResolvedValue({ flows: [], unavailable: true });
  expect(await service.listFlows()).toMatchObject({ flows: [], sharedFlowsUnavailable: true });
});
