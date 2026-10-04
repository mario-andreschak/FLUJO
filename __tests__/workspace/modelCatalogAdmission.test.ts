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

it('admits concurrent readers and keeps an edit and later readers behind both', async () => {
  const [first, second] = workers;
  await first.request({ type: 'catalogReplace', models: [ordinary] });
  await expect(first.request({ type: 'catalogGateEnter', mode: 'reader', token: 'reader-a', modelId: ordinary.id }))
    .resolves.toMatchObject({ held: true, modelId: ordinary.id });
  await expect(second.request({ type: 'catalogGateEnter', mode: 'reader', token: 'reader-b', modelId: ordinary.id }))
    .resolves.toMatchObject({ held: true, modelId: ordinary.id });

  const edit = first.request({ type: 'catalogGateEnter', mode: 'writer', token: 'edit', models: [bound] }, 30_000);
  expect(await first.request({ type: 'catalogGateStatus', token: 'edit' })).toEqual({ requested: true, held: false });
  await first.request({ type: 'catalogGateLeave', token: 'reader-a' });
  expect(await first.request({ type: 'catalogGateStatus', token: 'edit' })).toEqual({ requested: true, held: false });
  await second.request({ type: 'catalogGateLeave', token: 'reader-b' });
  await expect(edit).resolves.toMatchObject({ held: true });

  const later = second.request({ type: 'catalogGateEnter', mode: 'reader', token: 'later', modelId: ordinary.id }, 30_000);
  expect(await second.request({ type: 'catalogGateStatus', token: 'later' })).toEqual({ requested: true, held: false });
  await first.request({ type: 'catalogGateLeave', token: 'edit' });
  await expect(later).resolves.toMatchObject({ held: true });
  await second.request({ type: 'catalogGateLeave', token: 'later' });
});

it('rejects a missing admission, then observes a late owner-binding edit only after the reader releases', async () => {
  const [reader, writer] = workers;
  await expect(reader.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .rejects.toMatchObject({ code: 'execution_model_not_found' });
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'prep', modelId: ordinary.id });
  const edit = writer.request({ type: 'catalogGateEnter', mode: 'writer', token: 'late-edit', models: [bound] }, 30_000);
  expect(await writer.request({ type: 'catalogGateStatus', token: 'late-edit' })).toEqual({ requested: true, held: false });
  await reader.request({ type: 'catalogGateLeave', token: 'prep' });
  await expect(edit).resolves.toMatchObject({ held: true });
  await writer.request({ type: 'catalogGateLeave', token: 'late-edit' });
  await expect(reader.request({ type: 'catalogAdmissionProbe', modelId: ordinary.id }))
    .resolves.toMatchObject({ ownerBound: true });
});

it('retires a crashed reader before an edit and supports nested inline readers', async () => {
  const [reader, writer] = workers;
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'crashed', modelId: ordinary.id });
  const edit = writer.request({ type: 'catalogGateEnter', mode: 'writer', token: 'after-crash', models: [bound] }, 30_000);
  expect(await writer.request({ type: 'catalogGateStatus', token: 'after-crash' })).toEqual({ requested: true, held: false });
  await reader.kill();
  await expect(edit).resolves.toMatchObject({ held: true });
  await writer.request({ type: 'catalogGateLeave', token: 'after-crash' });
  await expect(writer.request({ type: 'catalogNestedProbe', modelId: ordinary.id }))
    .resolves.toEqual({ modelId: ordinary.id, writeRejected: true });
});

it('does not register a waiting catalog edit as a workspace mutation', async () => {
  const [reader, writer] = workers;
  await writer.request({ type: 'catalogReplace', models: [ordinary] });
  await reader.request({ type: 'catalogGateEnter', mode: 'reader', token: 'preparing', modelId: ordinary.id });
  const edit = writer.request({ type: 'catalogGateEnter', mode: 'writer', token: 'edit', models: [bound] }, 30_000);
  expect(await writer.request({ type: 'catalogGateStatus', token: 'edit' })).toEqual({ requested: true, held: false });

  // Workspace capture can close its own admission even while the catalog edit
  // waits for preparation. A resource write then resumes when capture exits.
  await writer.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'snapshot' });
  const resourceWrite = reader.request({ type: 'captureGateEnter', mode: 'writer', token: 'resource-write' }, 30_000);
  expect(await reader.request({ type: 'captureGateStatus', token: 'resource-write' }))
    .toEqual({ requested: true, held: false });
  await writer.request({ type: 'captureGateLeave', token: 'snapshot' });
  await expect(resourceWrite).resolves.toMatchObject({ held: true });
  await reader.request({ type: 'captureGateLeave', token: 'resource-write' });
  await reader.request({ type: 'catalogGateLeave', token: 'preparing' });
  await expect(edit).resolves.toMatchObject({ held: true });
  await writer.request({ type: 'catalogGateLeave', token: 'edit' });
});
