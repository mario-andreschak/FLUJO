/**
 * The allowed-model list must survive being saved. Losing it silently would lift the
 * limit, so this drives the real flow service against a throwaway data directory.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow } from '@/shared/types/flow';

describe('saving a flow with an allowed-model list', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-allowed-models-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    jest.resetModules();
  });

  afterEach(async () => {
    global.__flujo_flowsCache = null;
    global.__flujo_flowsMigration = undefined;
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const flow = (allowedModels: unknown): Flow => ({
    id: 'limited-flow',
    name: 'Limited',
    allowedModels,
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } }],
    edges: [],
  } as unknown as Flow);

  it('keeps the list, including an empty one', async () => {
    const { flowService } = await import('@/backend/services/flow');

    for (const list of [['model-a', 'model-b'], []]) {
      const saved = await flowService.saveFlow(flow(list));
      expect(saved.success).toBe(true);
      expect((await flowService.getFlow('limited-flow'))?.allowedModels).toEqual(list);
    }
  });

  it('refuses a malformed list rather than saving a limit that does not work', async () => {
    const { flowService } = await import('@/backend/services/flow');

    const saved = await flowService.saveFlow(flow('model-a'));

    expect(saved.success).toBe(false);
  });
});
