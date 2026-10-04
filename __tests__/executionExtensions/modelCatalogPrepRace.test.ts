import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { withModelCatalogWriteLease } from '@/backend/services/model/catalogAdmission';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getWorkspaceDbDir } from '@/utils/workspace';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import {
  removePersonaProcessEnvironment,
  startPersonaProcess,
  type PersonaProcessClient,
  type PersonaProcessEnvironment,
} from '../enduringAgents/personaProcessBoundaryHarness';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.setTimeout(120_000);

const ordinary = { id: 'prep-race-model', name: 'ordinary', provider: 'openai' as const, adapter: 'openai' as const, ApiKey: '' };
const bound = { ...ordinary, ownerCredentialBinding: { ownerId: 'owner-fixture', credentialId: 'credential-fixture' } };

function fixture() {
  const params = { id: 'process', label: 'Process', type: 'process', properties: {
    boundModel: ordinary.id,
    mcpNodes: [{ id: 'mcp', properties: { boundServer: 'fixture-server', enabledTools: [] } }],
  } } as ProcessNodeParams;
  const graph = { id: 'catalog-race-flow', name: 'Catalog race', nodes: [{
    id: 'process', type: 'process', position: { x: 0, y: 0 },
    data: { type: 'process', label: 'Process', properties: params.properties },
  }], edges: [] };
  const state = { trackingInfo: { executionId: 'catalog-race', startTime: 1, nodeExecutionTracker: [] },
    messages: [], flowId: graph.id, flowSnapshot: graph, conversationId: 'catalog-race-conversation',
    title: 'Race', createdAt: 1, updatedAt: 1 } as unknown as SharedState;
  return { state, params };
}

it('holds a live catalog edit behind an awaited Process preparation effect, then rejects the bound model before effects', async () => {
  await withModelCatalogWriteLease(() => saveItem(StorageKey.MODELS, [ordinary]));
  // This child uses Jest's isolated data root, so its catalog is the same file
  // while its lock owner is a separate OS process.
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-catalog-prep-race-'));
  const rootsDir = path.join(sandboxRoot, 'roots');
  await fs.mkdir(rootsDir);
  const environment: PersonaProcessEnvironment = {
    sandboxRoot,
    dataDir: process.env.FLUJO_DATA_DIR!,
    rootsDir,
    workspaceId: 'default-workspace',
  };
  let worker: PersonaProcessClient | undefined;
  let releaseRender: (() => void) | undefined;
  let releaseDiscovery: (() => void) | undefined;
  try {
    worker = await startPersonaProcess(environment);
    let enteredRender!: () => void;
    const renderEntered = new Promise<void>(resolve => { enteredRender = resolve; });
    const renderGate = new Promise<void>(resolve => { releaseRender = resolve; });
    let enteredDiscovery!: () => void;
    const discoveryEntered = new Promise<void>(resolve => { enteredDiscovery = resolve; });
    const discoveryGate = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    const render = jest.spyOn(promptRenderer, 'renderPrompt').mockImplementation(async () => {
      enteredRender();
      await renderGate;
      return 'Prepared prompt';
    });
    const discovery = jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async () => {
      enteredDiscovery();
      await discoveryGate;
      return { success: true, value: { availableTools: [] } } as never;
    });

    const first = fixture();
    const preparation = new ProcessNode().prep(first.state, first.params);
    await renderEntered;
    const edit = worker.request({ type: 'catalogGateEnter', mode: 'writer', token: 'bind', models: [bound] }, 30_000);
    releaseRender!();
    await discoveryEntered;
    // The writer owns admission while it drains our live reader. This proves
    // the worker reached the physical gate, not merely its RPC handler.
    const admissionFile = path.join(getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents', '.model-catalog-admission.lock');
    const deadline = Date.now() + 5_000;
    let ownerPid: number | undefined;
    while (Date.now() < deadline) {
      try { ownerPid = JSON.parse(await fs.readFile(admissionFile, 'utf8')).pid as number; }
      catch { /* registration has not reached the filesystem yet */ }
      if (ownerPid === worker.child.pid) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ownerPid).toBe(worker.child.pid);
    expect(await worker.request({ type: 'catalogGateStatus', token: 'bind' })).toEqual({ requested: true, held: false });
    releaseDiscovery!();
    await expect(preparation).resolves.toMatchObject({ boundModel: ordinary.id });
    expect(discovery).toHaveBeenCalledTimes(1);
    await expect(edit).resolves.toMatchObject({ held: true });
    await worker.request({ type: 'catalogGateLeave', token: 'bind' });

    const second = fixture();
    await expect(new ProcessNode().prep(second.state, second.params))
      .rejects.toMatchObject({ code: 'execution_model_step_context_required' });
    expect(render).toHaveBeenCalledTimes(1);
    expect(discovery).toHaveBeenCalledTimes(1);
  } finally {
    releaseRender?.();
    releaseDiscovery?.();
    jest.restoreAllMocks();
    await worker?.kill();
    await removePersonaProcessEnvironment(environment);
  }
});
