import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let workspaceDir: string;
const warnings = jest.fn();
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ warn: (...args: unknown[]) => warnings(...args) }) }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => workspaceDir }));
jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: (id: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('unsafe id');
  },
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
  writeFileAtomic: async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  },
}));

import { listConversationSummaries } from '@/backend/execution/flow/conversationSummaryStore';

let snapshotPath: string;
let summaryPath: string;
const snapshot = (title: string) => JSON.stringify({
  conversationId: 'conversation-1', messages: [], title, createdAt: 1, updatedAt: 2,
});

beforeEach(async () => {
  warnings.mockReset();
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-summary-file-race-'));
  snapshotPath = path.join(workspaceDir, 'db', 'conversations', 'conversation-1.json');
  summaryPath = path.join(workspaceDir, 'db', 'conversation-summaries', 'conversation-1.json');
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, snapshot('Original snapshot'));
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

it('indexes the checked descriptor when a rename replaces the pathname before reading', async () => {
  const open = fs.open.bind(fs);
  const replacementPath = path.join(workspaceDir, 'replacement.json');
  await fs.writeFile(replacementPath, snapshot('Replacement snapshot with different size'));
  let checkedSize = 0;
  let replaced = false;
  const closes: jest.Mock[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const close = jest.fn(handle.close.bind(handle));
    handle.close = close;
    closes.push(close);
    if (args[0] === snapshotPath) {
      const stat = handle.stat.bind(handle);
      handle.stat = jest.fn(async () => {
        const checked = await stat();
        checkedSize = checked.size;
        if (!replaced) {
          replaced = true;
          // Windows permits moving the open file, but can refuse overwriting
          // its pathname directly. Exercise replacement on both platforms.
          await fs.rename(snapshotPath, path.join(workspaceDir, 'original.json'));
          await fs.rename(replacementPath, snapshotPath);
        }
        return checked;
      }) as typeof handle.stat;
    }
    return handle;
  });

  expect({ summaries: await listConversationSummaries(), warnings: warnings.mock.calls }).toEqual({
    summaries: [expect.objectContaining({ title: 'Original snapshot' })], warnings: [],
  });
  expect(JSON.parse(await fs.readFile(summaryPath, 'utf8'))).toMatchObject({
    title: 'Original snapshot', snapshotSize: checkedSize,
  });
  expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
  jest.restoreAllMocks();

  // The sidecar records the old descriptor's fingerprint, so the next listing
  // notices the replacement and rebuilds rather than serving stale index data.
  expect(await listConversationSummaries()).toEqual([
    expect.objectContaining({ title: 'Replacement snapshot with different size' }),
  ]);
});

it.each(['cached', 'malformed'] as const)('closes the descriptor on the %s path', async mode => {
  if (mode === 'cached') await listConversationSummaries();
  else await fs.writeFile(snapshotPath, '{invalid json');
  const open = fs.open.bind(fs);
  const closes: jest.Mock[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const close = jest.fn(handle.close.bind(handle));
    handle.close = close;
    closes.push(close);
    return handle;
  });
  const summaries = await listConversationSummaries();
  expect(summaries).toHaveLength(mode === 'cached' ? 1 : 0);
  expect(closes).toHaveLength(1);
  expect(closes[0]).toHaveBeenCalledTimes(1);
});
