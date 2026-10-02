import { discoverAvatarConnections } from '@/backend/services/avatar/connectionDiscovery';
import type { Model } from '@/shared/types/model';

describe('passive avatar connection discovery', () => {
  const dependencies = () => ({
    codexRuntime: jest.fn(async () => 'available' as const),
    claudeRuntime: jest.fn(async () => 'available' as const),
    codexLogin: jest.fn(async () => ({ authentication: 'login-detected' as const })),
  });
  it('offers both SDK runtimes without treating the Claude host login as a saved Flujo token', async () => {
    const result = await discoverAvatarConnections([], dependencies());
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'codex-subscription', authentication: 'login-detected', nextAction: 'use-and-test', verification: 'untested' }),
      expect.objectContaining({ kind: 'claude-subscription', authentication: 'needs-connection', nextAction: 'connect-token', verification: 'untested' }),
    ]));
    expect(result.candidates.every(candidate => candidate.modelChoices.every(model => model.source === 'fallback'))).toBe(true);
  });
  it('projects only allowlisted saved-model metadata and excludes models unable to work with tools', async () => {
    const models: Model[] = [
      { id: 'claude', name: 'sonnet', displayName: 'My Claude', ApiKey: 'SECRET_TOKEN', adapter: 'claude-cli', provider: 'claude-subscription', promptTemplate: 'PRIVATE_PROMPT', baseUrl: 'https://PRIVATE.example' },
      { id: 'image', name: 'image-model', ApiKey: 'OTHER_SECRET', supportsTools: false },
    ];
    const result = await discoverAvatarConnections(models, dependencies());
    expect(result.candidates[0]).toMatchObject({ id: 'saved:claude', authentication: 'configured', verification: 'untested' });
    expect(result.candidates.some(candidate => candidate.modelId === 'image')).toBe(false);
    for (const secret of ['SECRET_TOKEN', 'PRIVATE_PROMPT', 'PRIVATE.example', 'OTHER_SECRET']) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('keeps an incompatible Codex store distinct from logout and never marks it usable', async () => {
    const deps = { ...dependencies(), codexLogin: jest.fn(async () => ({ authentication: 'incompatible' as const, reasonCode: 'credential-store-incompatible' })) };
    const result = await discoverAvatarConnections([{ id: 'c', name: 'gpt-5', ApiKey: '', adapter: 'codex-cli' }], deps);
    expect(result.candidates[0]).toMatchObject({ authentication: 'incompatible', nextAction: 'repair' });
    expect(result.candidates.find(candidate => candidate.kind === 'codex-subscription')).toMatchObject({ authentication: 'incompatible', nextAction: 'repair' });
  });
  it('keeps missing runtimes visible for repair even when login metadata exists', async () => {
    const result = await discoverAvatarConnections([], { ...dependencies(), codexRuntime: async () => 'missing' });
    expect(result.candidates[0]).toMatchObject({ runtime: 'missing', authentication: 'login-detected', nextAction: 'repair' });
  });
});
