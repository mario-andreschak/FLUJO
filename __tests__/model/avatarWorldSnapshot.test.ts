import { getAvatarWorldSnapshot } from '@/backend/services/avatar/worldSnapshot';
import { listInstalledPackages } from '@/backend/services/packages/installPackage';
jest.mock('@/backend/services/model', () => ({ modelService: { loadModels: async () => [] } }));
jest.mock('@/backend/services/avatar/workModel', () => ({ readAvatarWorkModel: async () => null }));
jest.mock('@/backend/services/flow', () => ({ flowService: { listFlows: async () => ({ success: true, flows: [
  { id: 'authored', name: 'Researcher' },
  { id: 'owned', name: 'Resident core', personaOwnership: { personaId: 'resident', kind: 'core' } },
] }) } }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { loadServerConfigs: async () => [] } }));
jest.mock('@/backend/services/scheduler', () => ({ getSchedulerService: () => ({ list: async () => [] }) }));
jest.mock('@/backend/services/enduringAgents/personaSummary', () => ({ listPersonaSummaries: async () => ({ hasMore: false, items: [
  { id: 'resident', name: 'Resident', status: 'paused', capabilities: { talk: true } },
  { id: 'unavailable', name: 'Unavailable', status: 'needs-attention', capabilities: { talk: false } },
] }) }));
jest.mock('@/backend/services/meetings/store', () => ({ listMeetingSummaries: async () => [] }));
jest.mock('@/backend/services/runResources', () => ({ listAllRunResources: async () => [] }));
jest.mock('@/backend/services/packages/installPackage', () => ({ listInstalledPackages: jest.fn(async () => []) }));
beforeEach(() => { jest.mocked(listInstalledPackages).mockReset().mockResolvedValue([]); });
it('keeps Persona-owned Flow inspection separate from Persona runtime authority', async () => {
  const world = await getAvatarWorldSnapshot();
  expect(world.objects.find(object => object.id === 'authored')).toMatchObject({ canTalk: true });
  expect(world.objects.find(object => object.id === 'owned')).toMatchObject({ canTalk: false, href: '/flows?flow=owned' });
  expect(world.objects.find(object => object.id === 'resident')).toMatchObject({ kind: 'persona', canTalk: true });
  expect(world.objects.find(object => object.id === 'unavailable')).toMatchObject({ canTalk: false });
});
it('projects bounded installed-package facts without exposing install summaries', async () => {
  jest.mocked(listInstalledPackages).mockResolvedValue(Array.from({ length: 51 }, (_, i) => ({
    packageName: `package-${i}`, version: '1.2.3', installedAt: '2026-10-02T00:00:00Z',
    entityCounts: { flows: 1, models: 0, servers: 0, plannedExecutions: 0 },
  })));
  const world = await getAvatarWorldSnapshot();
  const packages = world.objects.filter(object => object.kind === 'package');
  expect(packages).toHaveLength(50);
  expect(packages[0]).toEqual({ id: 'package-0', name: 'package-0', kind: 'package', state: 'v1.2.3', href: '/packages' });
  expect(world.truncated).toContain('packages');
});
it('keeps other world entities available when the package ledger fails', async () => {
  jest.mocked(listInstalledPackages).mockRejectedValue(new Error('Ledger unavailable'));
  const world = await getAvatarWorldSnapshot();
  expect(world.unavailable).toContain('packages');
  expect(world.objects.find(object => object.id === 'resident')).toBeDefined();
  expect(world.objects.some(object => object.kind === 'package')).toBe(false);
});
