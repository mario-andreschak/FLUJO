import { NextRequest } from 'next/server';

import { DELETE as deletePersona, GET as getPersona } from '@/app/v1/personas/[personaId]/route';
import { GET as previewPersonaDeletion } from '@/app/v1/personas/[personaId]/deletion-preview/route';
import { DELETE as forgetMemory } from '@/app/v1/personas/[personaId]/memories/[memoryId]/route';
import { POST as correctMemory } from '@/app/v1/personas/[personaId]/memories/[memoryId]/correct/route';
import { POST as pinMemory } from '@/app/v1/personas/[personaId]/memories/[memoryId]/pin/route';
import { GET as searchMemory, POST as rememberMemory } from '@/app/v1/personas/[personaId]/memories/route';
import { GET as listWorkItems, POST as createWorkItem } from '@/app/v1/personas/[personaId]/work-items/route';
import { POST as createPersona } from '@/app/v1/personas/route';
import { GET as listRoles } from '@/app/v1/roles/route';
import { StorageKey } from '@/shared/types/storage';
import { saveItem } from '@/utils/storage/backend';
import { ensureWorkspaceDirs, runWithWorkspace } from '@/utils/workspace';
import { ensureTestRole, TEST_ROLE_VERSION_ID } from './fixtures/personaFactory';

const workspaceA = `enduring-route-a-${process.pid}`;
const workspaceB = `enduring-route-b-${process.pid}`;

function request(
  path: string,
  workspace: string,
  init?: RequestInit,
): NextRequest {
  const headers = new Headers(init?.headers);
  headers.set('host', 'localhost');
  headers.set('x-flujo-workspace', workspace);
  return new NextRequest(`http://localhost${path}`, {
    ...init,
    signal: init?.signal ?? undefined,
    headers,
  });
}

describe('enduring-agent production routes', () => {
  beforeAll(async () => {
    await Promise.all([
      ensureWorkspaceDirs(workspaceA),
      ensureWorkspaceDirs(workspaceB),
    ]);
    await Promise.all([workspaceA, workspaceB].map((workspace) => (
      runWithWorkspace(workspace, async () => {
        await saveItem(StorageKey.MODELS, [{
          id: 'model-test',
          name: 'test-model',
          displayName: 'Test model',
          provider: 'openai',
        }]);
        await ensureTestRole();
      })
    )));
  });

  it('creates Jim through the real factory and keeps him workspace-scoped', async () => {
    const response = await createPersona(request('/v1/personas', workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Jim',
        roleVersionId: TEST_ROLE_VERSION_ID,
        idempotencyKey: 'route-create-jim',
      }),
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

  it('creates explicit initial memories and pins them in core composition', async () => {
    const response = await createPersona(request('/v1/personas', workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Memory Jim',
        roleVersionId: TEST_ROLE_VERSION_ID,
        idempotencyKey: 'route-create-memory-jim',
        initialMemories: [{ content: 'Jim prefers concise updates.' }],
      }),
    }) as never);

    expect(response.status).toBe(201);
    const bundle = await response.json();
    expect(bundle.memoryItems).toHaveLength(1);
    expect(bundle.memoryItems[0]).toMatchObject({
      personaId: bundle.persona.id,
      content: 'Jim prefers concise updates.',
      status: 'active',
      trust: 'explicit_user',
    });
    expect(bundle.persona.coreMemoryItemIds).toEqual([bundle.memoryItems[0].id]);
    expect(bundle.persona.composition.memoryRefs).toEqual([bundle.memoryItems[0].id]);
  });

  it('lists the explicitly created workspace Role through the real store', async () => {
    const response = await listRoles(request('/v1/roles', workspaceA) as never);

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.roleDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'role_test_general', name: 'Test general Role' }),
    ]));
    expect(result.roleVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: TEST_ROLE_VERSION_ID, version: 1 }),
    ]));
  });

  it('serves durable WorkItem and explicit memory lifecycles through the production API', async () => {
    const created = await createPersona(request('/v1/personas', workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Phase Four Jim',
        roleVersionId: TEST_ROLE_VERSION_ID,
        idempotencyKey: 'route-phase-four-jim',
      }),
    }) as never);
    const personaId = (await created.json()).persona.id as string;
    const personaContext = { params: Promise.resolve({ personaId }) } as never;

    const workResponse = await createWorkItem(request(`/v1/personas/${personaId}/work-items`, workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Ship the Phase 4 API',
        priority: 'urgent',
        deadline: Date.now() + 60_000,
        nextAction: 'Run the route integration test.',
      }),
    }), personaContext);
    expect(workResponse.status).toBe(201);
    expect(await workResponse.json()).toMatchObject({
      personaId,
      priority: 'urgent',
      status: 'open',
      nextAction: 'Run the route integration test.',
    });
    const listedWork = await listWorkItems(
      request(`/v1/personas/${personaId}/work-items?readyOnly=true`, workspaceA),
      personaContext,
    );
    expect(listedWork.status).toBe(200);
    expect(await listedWork.json()).toEqual([
      expect.objectContaining({ title: 'Ship the Phase 4 API' }),
    ]);

    const memoryResponse = await rememberMemory(request(`/v1/personas/${personaId}/memories`, workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'semantic',
        scope: 'persona',
        status: 'active',
        content: 'The Phase 4 API is the current focus.',
        confidence: 1,
        importance: 0.9,
        trust: 'explicit_user',
        sourceRefs: [{ kind: 'user_statement', id: 'route-phase-four-memory' }],
      }),
    }), personaContext);
    expect(memoryResponse.status).toBe(201);
    const memory = await memoryResponse.json();
    const memoryContext = {
      params: Promise.resolve({ personaId, memoryId: memory.id as string }),
    } as never;
    expect((await pinMemory(
      request(`/v1/personas/${personaId}/memories/${memory.id}/pin`, workspaceA, { method: 'POST' }) as never,
      memoryContext,
    )).status).toBe(200);
    const core = await searchMemory(
      request(`/v1/personas/${personaId}/memories?coreOnly=true&q=current+focus`, workspaceA),
      personaContext,
    );
    expect(await core.json()).toEqual([
      expect.objectContaining({
        core: true,
        item: expect.objectContaining({ id: memory.id }),
      }),
    ]);

    const correctedResponse = await correctMemory(request(
      `/v1/personas/${personaId}/memories/${memory.id}/correct`,
      workspaceA,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'The Phase 4 API and regression suite are the current focus.',
          sourceRefs: [{ kind: 'user_statement', id: 'route-phase-four-correction' }],
        }),
      },
    ), memoryContext);
    expect(correctedResponse.status).toBe(200);
    const corrected = await correctedResponse.json();
    expect(corrected).toMatchObject({ status: 'active', supersedes: [memory.id] });
    expect((await forgetMemory(
      request(`/v1/personas/${personaId}/memories/${corrected.id}`, workspaceA, { method: 'DELETE' }),
      { params: Promise.resolve({ personaId, memoryId: corrected.id as string }) } as never,
    )).status).toBe(200);
  });

  it('previews and deletes through the production workspace-scoped API', async () => {
    const created = await createPersona(request('/v1/personas', workspaceA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'persona_route_delete',
        name: 'Delete Me',
        roleVersionId: TEST_ROLE_VERSION_ID,
      }),
    }) as never);
    const personaId = (await created.json()).persona.id as string;
    const previewResponse = await previewPersonaDeletion(
      request(`/v1/personas/${personaId}/deletion-preview`, workspaceA) as never,
      { params: Promise.resolve({ personaId }) } as never,
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();

    const deleted = await deletePersona(
      request(`/v1/personas/${personaId}`, workspaceA, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewToken: preview.previewToken,
          archivePolicy: 'anonymize',
          confirmation: 'DELETE',
        }),
      }) as never,
      { params: Promise.resolve({ personaId }) } as never,
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).status).toBe('completed');

    const missing = await getPersona(
      request(`/v1/personas/${personaId}`, workspaceA) as never,
      { params: Promise.resolve({ personaId }) } as never,
    );
    expect(missing.status).toBe(404);
  });
});
