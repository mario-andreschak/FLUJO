import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessNode } from '@/backend/execution/flow/nodes/ProcessNode';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { withModelCatalogWriteLease } from '@/backend/services/model/catalogAdmission';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
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

it('rejects catalog edits during awaited Process preparation effects, then rejects a bound model before effects', async () => {
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
    await expect(worker.request({ type: 'catalogReplace', models: [bound] }, 5_000))
      .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });
    releaseRender!();
    await discoveryEntered;
    await expect(worker.request({ type: 'catalogReplace', models: [bound] }, 5_000))
      .rejects.toMatchObject({ code: 'MODEL_CATALOG_BUSY' });
    releaseDiscovery!();
    await expect(preparation).resolves.toMatchObject({ boundModel: ordinary.id });
    expect(discovery).toHaveBeenCalledTimes(1);
    await expect(worker.request({ type: 'catalogReplace', models: [bound] }))
      .resolves.toEqual({ saved: true });

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
