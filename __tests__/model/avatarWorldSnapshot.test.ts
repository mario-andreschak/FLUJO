import { getAvatarWorldSnapshot } from '@/backend/services/avatar/worldSnapshot';
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
it('keeps Persona-owned Flow inspection separate from Persona runtime authority', async () => {
  const world = await getAvatarWorldSnapshot();
  expect(world.objects.find(object => object.id === 'authored')).toMatchObject({ canTalk: true });
  expect(world.objects.find(object => object.id === 'owned')).toMatchObject({ canTalk: false, href: '/flows?flow=owned' });
  expect(world.objects.find(object => object.id === 'resident')).toMatchObject({ kind: 'persona', canTalk: true });
  expect(world.objects.find(object => object.id === 'unavailable')).toMatchObject({ canTalk: false });
});
