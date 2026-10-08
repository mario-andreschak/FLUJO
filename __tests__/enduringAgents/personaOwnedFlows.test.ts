import { promises as fs } from 'node:fs';
import path from 'node:path';
import { flowService } from '@/backend/services/flow';
import { withFlowMutationLock } from '@/backend/services/flow/personaOwnedFlows';
import { deletePersona, previewPersonaDeletion, PersonaDeletionConflictError } from '@/backend/services/enduringAgents/personaDeletion';
import { getPersona, getPersonaDeletionTombstone } from '@/backend/services/enduringAgents/store';
import { getWorkspaceDbDir, runWithWorkspace } from '@/utils/workspace';
import { loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import type { Flow } from '@/shared/types/flow';
import { createPersonaFromRole } from './fixtures/personaFactory';

let sequence = 0;
const fresh = <T>(task: () => Promise<T>) => runWithWorkspace(`owned-flows-${process.pid}-${++sequence}`, task);
const confirm = (previewToken: string) => ({ previewToken, archivePolicy: 'anonymize', confirmation: 'DELETE' });

async function setup() {
  const { persona } = await createPersonaFromRole({ id: 'owned_flow_persona', name: 'Private Author' });
  const coreFlowRef = persona.composition?.coreFlowRef;
  if (!coreFlowRef) throw new Error('The fixture Persona must have an authored Core Flow.');
  const flow = (await flowService.getFlow(coreFlowRef))!;
  expect(flow.personaOwnership?.personaId).toBe(persona.id);
  const shared: Flow = { ...structuredClone(flow), id: 'shared_source', name: 'Shared source', personaOwnership: undefined };
  expect(await flowService.saveFlow(shared)).toEqual({ success: true });
  return { persona, flow, shared };
}

describe('Persona-owned authoring Flow erasure', () => {
  it('counts and erases private copies, superseded versions and migration backups while preserving shared Flows', async () => fresh(async () => {
    const { persona, flow, shared } = await setup();
    await flowService.saveFlow({ ...flow, name: 'Private revision' });
    await saveCollectionItem('flow-behavior-rules-backups', flow.id, { flowId: flow.id, flow });
    const preview = await previewPersonaDeletion(persona.id);
    expect(preview.counts.ownedFlows).toBe(3);
    expect(preview.counts.ownedFlowFiles).toBe(5);
    await deletePersona(persona.id, confirm(preview.previewToken));
    expect(await flowService.inspectPersonaOwnedFlows(persona.id)).toEqual({ flowIds: [], files: [] });
    expect(await flowService.getFlow(shared.id)).toMatchObject({ name: shared.name });
    expect(await flowService.getFlow(flow.id)).toBeNull();
    expect(await flowService.saveFlow(flow)).toMatchObject({ success: false, error: expect.stringMatching(/missing or being deleted/) });
    expect(await flowService.getFlow(flow.id)).toBeNull();
  }));

  it('invalidates a reviewed deletion after an owned edit and rejects ownership stripping or adoption', async () => fresh(async () => {
    const { persona, flow, shared } = await setup();
    const preview = await previewPersonaDeletion(persona.id);
    expect(await flowService.saveFlow({ ...flow, personaOwnership: undefined })).toMatchObject({ success: false });
    expect(await flowService.saveFlow({ ...shared, personaOwnership: flow.personaOwnership })).toMatchObject({ success: false });
    expect(await flowService.saveFlow({ ...flow, description: 'New private instruction' })).toEqual({ success: true });
    await expect(deletePersona(persona.id, confirm(preview.previewToken))).rejects.toBeInstanceOf(PersonaDeletionConflictError);
    expect(await getPersona(persona.id)).not.toBeNull();
  }));

  it('keeps deletion retryable when erasing history fails and removes leftover bytes on retry', async () => fresh(async () => {
    const { persona, flow } = await setup();
    await flowService.saveFlow({ ...flow, name: 'Private second version' });
    const preview = await previewPersonaDeletion(persona.id);
    const original = fs.unlink;
    let injected = false;
    const spy = jest.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (!injected && String(file).includes(`${path.sep}flow-versions${path.sep}${flow.id}${path.sep}`)) {
        injected = true; throw Object.assign(new Error('injected erasure failure'), { code: 'EACCES' });
      }
      return original(file);
    });
    try { await expect(deletePersona(persona.id, confirm(preview.previewToken))).rejects.toThrow('injected erasure failure'); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect((await getPersonaDeletionTombstone(persona.id))?.status).toBe('deleting');
    expect(await loadCollectionItem('flows', flow.id, null)).not.toBeNull();
    expect(await flowService.getFlow(flow.id)).toBeNull();
    expect(await flowService.listFlowVersions(flow.id)).toEqual([]);
    await deletePersona(persona.id, confirm(preview.previewToken));
    expect((await getPersonaDeletionTombstone(persona.id))?.status).toBe('completed');
    expect((await flowService.inspectPersonaOwnedFlows(persona.id)).files).toEqual([]);
  }));

  it('cleans owned copies left behind by an older completed deletion receipt on explicit retry', async () => fresh(async () => {
    const { persona, flow } = await setup();
    const preview = await previewPersonaDeletion(persona.id);
    await deletePersona(persona.id, confirm(preview.previewToken));
    await saveCollectionItem('flows', flow.id, flow);
    expect(await flowService.getFlow(flow.id)).toBeNull();
    await deletePersona(persona.id, confirm(preview.previewToken));
    expect(await loadCollectionItem('flows', flow.id, null)).toBeNull();
  }));

  it('drains an admitted authoring operation and refuses a queued save after deletion', async () => fresh(async () => {
    const { persona, flow } = await setup();
    const preview = await previewPersonaDeletion(persona.id);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = withFlowMutationLock(async () => {
      entered(); await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    const deleting = deletePersona(persona.id, confirm(preview.previewToken));
    release(); await held; await deleting;
    expect(await flowService.saveFlow({ ...flow, name: 'Late editor write' })).toMatchObject({ success: false });
    expect(await loadCollectionItem('flows', flow.id, null)).toBeNull();
  }));

  it('refuses linked Flow history without touching its external target', async () => fresh(async () => {
    const { persona, flow } = await setup();
    const versions = path.join(getWorkspaceDbDir(), 'flow-versions');
    const external = path.join(getWorkspaceDbDir(), 'unrelated-history');
    await fs.mkdir(versions, { recursive: true }); await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'keep.txt'), 'retained');
    await fs.symlink(external, path.join(versions, flow.id), 'junction');
    await expect(previewPersonaDeletion(persona.id)).rejects.toThrow(/real workspace directories/);
    expect(await fs.readFile(path.join(external, 'keep.txt'), 'utf8')).toBe('retained');
    expect(await getPersonaDeletionTombstone(persona.id)).toBeNull();
  }));
});
