import type { Flow } from '@/shared/types/flow';
import {
  createPersonaProcessEnvironment, removePersonaProcessEnvironment, startPersonaProcess,
  type PersonaProcessClient,
} from './personaProcessBoundaryHarness';

jest.setTimeout(120_000);

it('recovers a killed authoring lock owner, erases private copies and rejects a stale editor in another process', async () => {
  const environment = await createPersonaProcessEnvironment('owned-flow-process');
  const clients: PersonaProcessClient[] = [];
  try {
    const writer = await startPersonaProcess(environment); clients.push(writer);
    const reader = await startPersonaProcess(environment); clients.push(reader);
    const created = await writer.request<{ persona: { id: string; composition: { coreFlowRef: string } } }>({
      type: 'createPersona', name: 'Private process actor', idempotencyKey: 'create', coreFlowRef: 'owned_process_core',
    });
    const personaId = created.persona.id;
    const flowId = created.persona.composition.coreFlowRef;
    const draft = await reader.request<Flow>({ type: 'readFlow', flowId });
    expect(draft.personaOwnership?.personaId).toBe(personaId);
    const preview = await reader.request<{ previewToken: string }>({ type: 'previewDeletion', personaId });
    await writer.request({ type: 'captureGateEnter', mode: 'flow', token: 'held-authoring' });
    let finished = false;
    const deleting = reader.request({ type: 'deletePersona', personaId, previewToken: preview.previewToken }, 60_000)
      .finally(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    expect(await writer.request({ type: 'captureGateStatus', token: 'held-authoring' })).toMatchObject({ held: true });
    await writer.kill();
    await expect(deleting).resolves.toMatchObject({ status: 'completed' });
    expect(await reader.request({ type: 'readFlow', flowId })).toBeNull();
    const restarted = await startPersonaProcess(environment); clients.push(restarted);
    expect(await restarted.request({ type: 'saveFlow', flow: draft })).toMatchObject({ success: false });
    expect(await restarted.request({ type: 'readFlow', flowId })).toBeNull();
    expect(await restarted.request({ type: 'readFlow', flowId: 'owned_process_core' })).toMatchObject({ id: 'owned_process_core' });
  } finally {
    await Promise.all(clients.map((client) => client.kill()));
    await removePersonaProcessEnvironment(environment);
  }
});
