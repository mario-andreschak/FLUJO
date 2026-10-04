import {
  createPersonaProcessEnvironment,
  removePersonaProcessEnvironment,
  startPersonaProcess,
  type PersonaProcessClient,
  type PersonaProcessEnvironment,
} from '../enduringAgents/personaProcessBoundaryHarness';
import type { Model } from '@/shared/types/model';

jest.setTimeout(120_000);

const ordinary: Model = { id: 'catalog-model', name: 'ordinary-fixture', provider: 'openai', adapter: 'openai', ApiKey: '' };
const bound: Model = {
  ...ordinary,
  name: 'owner-fixture',
  ownerCredentialBinding: { ownerId: 'owner-fixture', credentialId: 'credential-fixture' },
};
let environment: PersonaProcessEnvironment;
let workers: PersonaProcessClient[];

beforeEach(async () => {
  environment = await createPersonaProcessEnvironment('model-catalog');
  workers = [await startPersonaProcess(environment), await startPersonaProcess(environment)];
});

afterEach(async () => {
  await Promise.allSettled(workers.map(worker => worker.kill()));
  await removePersonaProcessEnvironment(environment);
});

it('admits concurrent readers and rejects an edit promptly until both release', async () => {
  const [first, second] = workers;
  await first.request({ type: 'catalogReplace', models: [ordinary] });
  await expect(first.request({ type: 'catalogGateEnter', mode: 'reader', token: 'reader-a', modelId: ordinary.id }))
    .resolves.toMatchObject({ held: true, modelId: ordinary.id });
  await expect(second.request({ type: 'catalogGateEnter', mode: 'reader', token: 'reader-b', modelId: ordinary.id }))
    .resolves.toMatchObject({ held: true, modelId: ordinary.id });

  await expect(first.request({ type: 'catalogReplace', models: [bound] }, 5_000))
    .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });
  await expect(second.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .resolves.toMatchObject({ ownerBound: false });
  await first.request({ type: 'catalogGateLeave', token: 'reader-a' });
  await expect(first.request({ type: 'catalogReplace', models: [bound] }, 5_000))
    .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });
  await second.request({ type: 'catalogGateLeave', token: 'reader-b' });
  await expect(first.request({ type: 'catalogReplace', models: [bound] }))
    .resolves.toEqual({ saved: true });
  await expect(second.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .resolves.toMatchObject({ ownerBound: true });
});

it('rejects a missing admission, then refuses a late owner-binding edit during preparation', async () => {
  const [reader, writer] = workers;
  await expect(reader.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .rejects.toMatchObject({ code: 'execution_model_not_found' });
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'prep', modelId: ordinary.id });
  await expect(writer.request({ type: 'catalogReplace', models: [bound] }, 5_000))
    .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });
  await reader.request({ type: 'catalogGateLeave', token: 'prep' });
  await writer.request({ type: 'catalogReplace', models: [bound] });
  await expect(reader.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .resolves.toMatchObject({ ownerBound: true });
});

it('retires a crashed reader before an edit and supports nested inline readers', async () => {
  const [reader, writer] = workers;
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'crashed', modelId: ordinary.id });
  await reader.kill();
  await expect(writer.request({ type: 'catalogReplace', models: [bound] }))
    .resolves.toEqual({ saved: true });
  await expect(writer.request({ type: 'catalogNestedProbe', modelId: ordinary.id }))
    .resolves.toEqual({ modelId: ordinary.id, writeRejected: true });
});

it('leaves workspace capture available after a busy catalog edit', async () => {
  const [reader, writer] = workers;
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'preparing', modelId: ordinary.id });
  await expect(writer.request({ type: 'catalogReplace', models: [bound] }, 5_000))
    .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });

  // Workspace capture can close its own admission after the catalog edit is
  // refused. A resource write then resumes when capture exits.
  await writer.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'snapshot' });
  const resourceWrite = reader.request({ type: 'captureGateEnter', mode: 'writer', token: 'resource-write' }, 30_000);
  expect(await reader.request({ type: 'captureGateStatus', token: 'resource-write' }))
    .toEqual({ requested: true, held: false });
  await writer.request({ type: 'captureGateLeave', token: 'snapshot' });
  await expect(resourceWrite).resolves.toMatchObject({ held: true });
  await reader.request({ type: 'captureGateLeave', token: 'resource-write' });
  await reader.request({ type: 'catalogGateLeave', token: 'preparing' });
  await expect(writer.request({ type: 'catalogReplace', models: [bound] }))
    .resolves.toEqual({ saved: true });
});
