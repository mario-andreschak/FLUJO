import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPrivateProfileFixture, unlockPrivateFixtureInCurrentWorkspace } from '../utils/privateProfileFixture';
import { runWithWorkspace } from '@/utils/workspace';
import { GET } from '@/app/v1/models/route';
import { modelService } from '@/backend/services/model';

jest.mock('@/backend/services/model', () => ({ modelService: { listModels: jest.fn() } }));

describe('OpenAI client discovery of saved Flow collections', () => {
  let fixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
  beforeEach(async () => {
    (modelService.listModels as jest.Mock).mockReset().mockResolvedValue({ success: true, models: [] });
    fixture = await installPrivateProfileFixture();
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
  });
  afterEach(async () => {
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    await fixture.restore();
  });

  it('lists current per-Flow records without requiring a legacy flows.json array', async () => {
    const directory = path.join(fixture.root, 'workspaces', 'default-workspace', 'db', 'flows');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'saved-flow.json'), JSON.stringify({
      id: 'saved-flow', name: 'Saved MCP agent', nodes: [], edges: [],
      description: 'Private authoring details must not be listed',
    }));
    const response = await GET(new Request('http://localhost/v1/models?workspace=default-workspace'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'flow-Saved MCP agent', object: 'model' }] });
    await expect(fs.access(path.join(directory, '..', 'flows.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes a stable team identifier and no shared configuration or credential data', async () => {
    const id = `team-model:${'t'.repeat(43)}:${'r'.repeat(43)}`;
    (modelService.listModels as jest.Mock).mockResolvedValue({ success: true, models: [
      { id, name: 'local', displayName: 'Team AI', ApiKey: 'must-not-leak', promptTemplate: 'shared prompt',
        baseUrl: 'http://127.0.0.1:4290/private-transport' },
    ] });
    const response = await GET(new Request('http://localhost/v1/models?workspace=default-workspace'));
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: `model-${id}`, object: 'model' }] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps external client discovery scoped to the requested workspace', async () => {
    const team = `team-${randomUUID().slice(0, 8)}`;
    for (const [workspace, name] of [['default-workspace', 'Default agent'], [team, 'Team agent']]) {
      const directory = path.join(fixture.root, 'workspaces', workspace, 'db', 'flows');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'same-id.json'), JSON.stringify({ id: 'same-id', name, nodes: [], edges: [] }));
    }
    await runWithWorkspace(team, () => unlockPrivateFixtureInCurrentWorkspace());
    for (const [workspace, name] of [['default-workspace', 'Default agent'], [team, 'Team agent']]) {
      const response = await GET(new Request(`http://localhost/v1/models?workspace=${workspace}`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ object: 'list', data: [{ id: `flow-${name}`, object: 'model' }] });
    }
  });

  it('continues to discover a legacy Flow array through the shared migration path', async () => {
    const db = path.join(fixture.root, 'workspaces', 'default-workspace', 'db');
    await fs.writeFile(path.join(db, 'flows.json'), JSON.stringify([{ id: 'earlier-flow', name: 'Earlier agent', nodes: [], edges: [] }]));
    const response = await GET(new Request('http://localhost/v1/models?workspace=default-workspace'));
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'flow-Earlier agent', object: 'model' }] });
    expect(JSON.parse(await fs.readFile(path.join(db, 'flows', 'earlier-flow.json'), 'utf8'))).toMatchObject({ id: 'earlier-flow', name: 'Earlier agent' });
  });
});
