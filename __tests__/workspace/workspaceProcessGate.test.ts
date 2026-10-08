import {
  createPersonaProcessEnvironment,
  removePersonaProcessEnvironment,
  startPersonaProcess,
  type PersonaProcessClient,
  type PersonaProcessEnvironment,
} from '../enduringAgents/personaProcessBoundaryHarness';

jest.setTimeout(120_000);

let environment: PersonaProcessEnvironment;
let clients: PersonaProcessClient[];

beforeEach(async () => {
  environment = await createPersonaProcessEnvironment('workspace-capture');
  clients = [];
  for (let index = 0; index < 2; index++) clients.push(await startPersonaProcess(environment));
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.kill()));
  if (environment) await removePersonaProcessEnvironment(environment);
});

async function requestedButWaiting(client: PersonaProcessClient, token: string) {
  // Commands use independent async handlers. This receipt proves that the
  // pending request reached the second process before we release the first.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await client.request({ type: 'captureGateStatus', token })).toEqual({ requested: true, held: false });
}

it('allows concurrent writers, drains both, and holds new writers until capture finishes', async () => {
  const [first, second] = clients;
  await first.request({ type: 'captureGateEnter', mode: 'writer', token: 'first' });
  await second.request({ type: 'captureGateEnter', mode: 'writer', token: 'second' });
  const snapshot = first.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'capture' });
  await requestedButWaiting(first, 'capture');
  await first.request({ type: 'captureGateLeave', token: 'first' });
  await requestedButWaiting(first, 'capture');
  await second.request({ type: 'captureGateLeave', token: 'second' });
  await expect(snapshot).resolves.toMatchObject({ held: true });
  const waiting = second.request({ type: 'captureGateEnter', mode: 'writer', token: 'later' });
  await requestedButWaiting(second, 'later');
  await first.request({ type: 'captureGateLeave', token: 'capture' });
  await expect(waiting).resolves.toMatchObject({ held: true });
  await second.request({ type: 'captureGateLeave', token: 'later' });
});

it('recovers a crashed admitted writer before entering capture', async () => {
  const [writer, reader] = clients;
  await writer.request({ type: 'captureGateEnter', mode: 'writer', token: 'writer' });
  const snapshot = reader.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'capture' });
  await requestedButWaiting(reader, 'capture');
  await writer.kill();
  await expect(snapshot).resolves.toMatchObject({ held: true });
  await reader.request({ type: 'captureGateLeave', token: 'capture' });
});

it('recovers a crashed capture owner without leaving write admission closed', async () => {
  const [reader, writer] = clients;
  await reader.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'capture' });
  const mutation = writer.request({ type: 'captureGateEnter', mode: 'writer', token: 'writer' });
  await requestedButWaiting(writer, 'writer');
  await reader.kill();
  await expect(mutation).resolves.toMatchObject({ held: true });
  await writer.request({ type: 'captureGateLeave', token: 'writer' });
});

it('fails a capture deadline without stealing a live writer or blocking subsequent work', async () => {
  const [writer, reader] = clients;
  await writer.request({ type: 'captureGateEnter', mode: 'writer', token: 'writer' });
  await expect(reader.request({ type: 'captureGateEnter', mode: 'snapshot', token: 'capture', timeoutMs: 150 }))
    .rejects.toThrow('Timed out waiting for workspace processes');
  expect(await writer.request({ type: 'captureGateStatus', token: 'writer' })).toMatchObject({ held: true });
  await writer.request({ type: 'captureGateLeave', token: 'writer' });
  await reader.request({ type: 'captureGateEnter', mode: 'writer', token: 'after-timeout' });
  await reader.request({ type: 'captureGateLeave', token: 'after-timeout' });
});

it('keeps capture admission isolated between workspaces under the same data root', async () => {
  const otherWorkspace = await startPersonaProcess({ ...environment, workspaceId: 'capture-other-workspace' });
  clients.push(otherWorkspace);
  await clients[0].request({ type: 'captureGateEnter', mode: 'snapshot', token: 'capture' });
  await expect(otherWorkspace.request({ type: 'captureGateEnter', mode: 'writer', token: 'other' }))
    .resolves.toMatchObject({ held: true });
  expect(await clients[0].request({ type: 'captureGateStatus', token: 'capture' })).toMatchObject({ held: true });
  await otherWorkspace.request({ type: 'captureGateLeave', token: 'other' });
  await clients[0].request({ type: 'captureGateLeave', token: 'capture' });
});
