import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import {
  createPersonaProcessEnvironment, startPersonaProcess, removePersonaProcessEnvironment,
  type PersonaProcessClient, type PersonaProcessEnvironment,
} from '../../enduringAgents/personaProcessBoundaryHarness';

jest.setTimeout(180_000);

it('reconciles a local Worker detached launch after OS process death without changing a copied snapshot task or a live launcher', async () => {
  const savedWorkerMode = process.env.FLUJO_WORKER_MODE;
  process.env.FLUJO_WORKER_MODE = '1';
  const environments: PersonaProcessEnvironment[] = [];
  const clients: PersonaProcessClient[] = [];
  try {
    const worker = await createPersonaProcessEnvironment('detached-restart');
    const source = await createPersonaProcessEnvironment('detached-snapshot-source');
    source.workspaceId = worker.workspaceId;
    environments.push(worker, source);
    const original = await startPersonaProcess(worker);
    clients.push(original);
    const local = await original.request<SubflowTaskRecord>({ type: 'launchDetachedTask', childConversationId: 'local-child' });
    expect(local.status).toBe('working');
    expect(local.launchOwner?.pid).toBe(original.child.pid);

    const snapshotSource = await startPersonaProcess(source);
    clients.push(snapshotSource);
    const copied = await snapshotSource.request<SubflowTaskRecord>({ type: 'launchDetachedTask', childConversationId: 'copied-child' });
    expect(copied.launchOwner?.installationId).not.toBe(local.launchOwner?.installationId);
    await snapshotSource.kill();
    const sourceDb = path.join(source.dataDir, 'workspaces', source.workspaceId, 'db');
    const workerDb = path.join(worker.dataDir, 'workspaces', worker.workspaceId, 'db');
    const copiedFiles = [`subflow-tasks/${copied.taskId}.json`, 'conversations/copied-child.json'];
    for (const file of copiedFiles) await fs.copyFile(path.join(sourceDb, file), path.join(workerDb, file));
    const originalCopiedBytes = await Promise.all(copiedFiles.map(file => fs.readFile(path.join(workerDb, file))));

    // A second process using the same root cannot mistake the first live
    // launcher for a dead process, even though its recovery UUID differs.
    const restarted = await startPersonaProcess(worker);
    clients.push(restarted);
    expect(await restarted.request({ type: 'getDetachedTask', taskId: local.taskId })).toMatchObject({ status: 'working' });
    expect(await restarted.request({ type: 'reconcileDetachedTasks' })).toEqual({ failed: 0 });
    await original.kill();

    expect(await restarted.request({ type: 'reconcileDetachedTasks' })).toEqual({ failed: 1 });
    const failed = await restarted.request<SubflowTaskRecord>({ type: 'getDetachedTask', taskId: local.taskId });
    expect(failed).toMatchObject({
      status: 'failed', failureReason: 'process-restart', completedAt: expect.any(Number),
      interruption: { childConversationId: 'local-child', classification: 'interrupted', manualActionRequired: true },
    });
    const child = JSON.parse(await fs.readFile(path.join(workerDb, 'conversations/local-child.json'), 'utf8'));
    expect(child).toMatchObject({ status: 'error', recovery: { classification: 'interrupted', failure: { category: 'unclean_process_interruption', retryable: false }, manualActionRequired: true } });
    expect(await restarted.request({ type: 'getDetachedTask', taskId: copied.taskId })).toMatchObject({ status: 'working' });
    for (let index = 0; index < copiedFiles.length; index++) {
      expect(await fs.readFile(path.join(workerDb, copiedFiles[index]))).toEqual(originalCopiedBytes[index]);
    }
    expect(await restarted.request({ type: 'reconcileDetachedTasks' })).toEqual({ failed: 0 });
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
    await Promise.all(environments.map(environment => removePersonaProcessEnvironment(environment)));
    if (savedWorkerMode === undefined) delete process.env.FLUJO_WORKER_MODE;
    else process.env.FLUJO_WORKER_MODE = savedWorkerMode;
  }
});
