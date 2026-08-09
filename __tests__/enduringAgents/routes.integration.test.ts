import { GET as getPersona } from '@/app/v1/personas/[personaId]/route';
import { POST as createPersona } from '@/app/v1/personas/route';
import { GET as listRoles } from '@/app/v1/roles/route';
import { ensureWorkspaceDirs } from '@/utils/workspace';

const workspaceA = `enduring-route-a-${process.pid}`;
const workspaceB = `enduring-route-b-${process.pid}`;

function request(
  path: string,
  workspace: string,
  init?: RequestInit,
): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      host: 'localhost',
      'x-flujo-workspace': workspace,
      ...(init?.headers ?? {}),
    },
  });
}

describe('enduring-agent production routes', () => {
  beforeAll(async () => {
    await Promise.all([
      ensureWorkspaceDirs(workspaceA),
      ensureWorkspaceDirs(workspaceB),
    ]);
  });

  it('creates Jim through the real factory and keeps him workspace-scoped', async () => {
    const response = await createPersona(request('/v1/personas', workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Jim', idempotencyKey: 'route-create-jim' }),
    }) as never);

    expect(response.status).toBe(201);
    const bundle = await response.json();
    expect(bundle.persona).toMatchObject({
      name: 'Jim',
      lifecycleState: 'idle',
      provisioningState: 'ready',
    });
    expect(bundle.behaviorBindings.map((binding: { slotKey: string }) => binding.slotKey).sort())
      .toEqual(['maintain_memory', 'primary']);

    const loaded = await getPersona(
      request(`/v1/personas/${bundle.persona.id}`, workspaceA) as never,
      { params: Promise.resolve({ personaId: bundle.persona.id }) } as never,
    );
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).persona.id).toBe(bundle.persona.id);

    const isolated = await getPersona(
      request(`/v1/personas/${bundle.persona.id}`, workspaceB) as never,
      { params: Promise.resolve({ personaId: bundle.persona.id }) } as never,
    );
    expect(isolated.status).toBe(404);
  });

  it('lists the built-in Role through the real workspace store', async () => {
    const response = await listRoles(request('/v1/roles', workspaceA) as never);

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.roleDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'role_builtin_developer', name: 'Developer' }),
    ]));
    expect(result.roleVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rolever_builtin_developer_v1', version: 1 }),
    ]));
  });
});
