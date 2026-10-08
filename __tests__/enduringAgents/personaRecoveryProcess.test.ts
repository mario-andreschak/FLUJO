import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createPersonaProcessEnvironment, removePersonaProcessEnvironment, startPersonaProcess,
  type PersonaProcessClient, type PersonaProcessEnvironment,
} from './personaProcessBoundaryHarness';

jest.setTimeout(120_000);
let environment: PersonaProcessEnvironment;
let clients: PersonaProcessClient[];
beforeEach(async () => { environment = await createPersonaProcessEnvironment('recovery-crash'); clients = []; });
afterEach(async () => {
  await Promise.all(clients.map((client) => client.kill()));
  if (environment) await removePersonaProcessEnvironment(environment);
});

it.each(['file_written', 'before_publish', 'published'] as const)('recovers a real process kill at %s without publishing partial work or replaying old authority', async (checkpoint) => {
  const writer = await startPersonaProcess(environment); clients.push(writer);
  const created = await writer.request<{ persona: { id: string } }>({ type: 'createPersona', name: 'Crash recovery actor', idempotencyKey: 'create', coreFlowRef: 'recovery_core' });
  const captured = await writer.request<{ archive: string }>({ type: 'captureRecovery' }, 30_000);
  const destination = `${environment.workspaceId}-restored`;
  const { previewToken } = await writer.request<{ previewToken: string }>({ type: 'previewRecovery', archive: captured.archive, destination });
  // Attach rejection immediately: the deliberate kill must reject the pending
  // response, not become an unhandled rejection while the test inspects disk.
  const pending = writer.request({ type: 'restoreRecovery', archive: captured.archive, destination, previewToken, holdAt: checkpoint }, 60_000)
    .then(() => 'unexpected completion', () => 'process exited');
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = await writer.request<{ checkpoint?: string }>({ type: 'recoveryCheckpoint' });
    if (state.checkpoint === checkpoint) break;
    if (Date.now() > deadline) throw new Error(`Restore did not reach ${checkpoint}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const workspaceRoot = path.join(environment.dataDir, 'workspaces');
  expect((await fs.readdir(workspaceRoot)).includes(destination)).toBe(checkpoint === 'published');
  const exit = await writer.kill();
  expect(exit.code !== 0 || exit.signal !== null).toBe(true);
  expect(await pending).toBe('process exited');
  const reader = await startPersonaProcess(environment); clients.push(reader);
  const restored = await reader.request<{ status: string }>({ type: 'restoreRecovery', archive: captured.archive, destination, previewToken }, 30_000);
  expect(restored.status).toBe(checkpoint === 'published' ? 'already_restored' : 'restored');
  const recoveredPersona = JSON.parse(await fs.readFile(path.join(workspaceRoot, destination, 'db/personas', `${created.persona.id}.json`), 'utf8'));
  expect(recoveredPersona).toMatchObject({ lifecycleState: 'disabled', autonomyLevel: 'locked' });
  expect(await fs.readFile(path.join(workspaceRoot, destination, 'db/persona-recovery/source.zip'))).toEqual(Buffer.from(captured.archive, 'base64'));
  expect((await reader.request<{ archive: string }>({ type: 'captureRecovery' }, 30_000)).archive).not.toBe('');
  expect((await reader.request<{ status: string }>({ type: 'restoreRecovery', archive: captured.archive, destination, previewToken }, 30_000)).status).toBe('already_restored');
});
