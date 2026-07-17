/**
 * Tier 3 run-resource store — concurrency regression (issue #124).
 *
 * Reproduces the lost-update race: `writeRunResource` used to do loadIndex →
 * mutate → saveIndex with the write chain entered only INSIDE saveIndex, so N
 * concurrent writes to the SAME conversation all read the same base index and
 * clobbered each other — only the last entry survived. The fix runs the whole
 * read-modify-write (incl. the payload file write) inside one
 * `runInWriteChain(chainKey(conversationId))` critical section (`mutateIndex`),
 * so every entry lands.
 *
 * Also guards the `readRunResource` lineage persist, which is now AWAITED and
 * routed through the same chain: N concurrent reads-with-access must retain
 * every readBy entry.
 *
 * These tests FAIL on `main` and PASS after the fix. Separate file from
 * runResourceStore.test.ts (that suite pins tiny caps); here caps are generous
 * enough for N resources so the test measures the race, not a cap refusal.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  writeRunResource,
  listRunResources,
  readRunResource,
  _setRunResourcesDirForTests,
  _clearRunResourceSettingsCache,
} from '@/backend/services/runResources';
import type { RunResourceEntry } from '@/shared/types/runResources';

// Defaults but with caps comfortably above the test payloads so N resources all
// fit (the race, not a cap, is what we are measuring).
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => ({
      ...(defaultValue as Record<string, unknown>),
      maxResourceBytes: 4096,
      maxConversationBytes: 10_000_000,
    })),
  };
});

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runres-race-'));
  previousDir = _setRunResourcesDirForTests(tmpDir);
});

afterAll(async () => {
  _setRunResourcesDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _clearRunResourceSettingsCache();
});

const producedBy = { source: 'capture' as const, nodeId: 'node-1' };

describe('concurrent writeRunResource (lost-update regression)', () => {
  it('keeps every entry when N unnamed resources are written to the same conversation concurrently', async () => {
    const N = 50;
    const conversationId = 'raceConv';
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeRunResource({
          conversationId,
          kind: 'text',
          data: { text: `r${i}` },
          producedBy,
        })
      )
    );

    const entries = await listRunResources(conversationId);
    expect(entries.length).toBe(N);
    // Every distinct payload survived.
    const texts = new Set(entries.map(e => e.id));
    expect(texts.size).toBe(N);
  });

  it('writes to different conversations concurrently all land (no cross-conversation over-serialization)', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        writeRunResource({
          conversationId: `conv${i}`,
          kind: 'text',
          data: { text: `x${i}` },
          producedBy,
        })
      )
    );
    for (let i = 0; i < N; i++) {
      expect((await listRunResources(`conv${i}`)).length).toBe(1);
    }
  });
});

describe('concurrent readRunResource lineage persist', () => {
  it('retains every readBy access when reads with access run concurrently', async () => {
    const conversationId = 'readConv';
    const written = (await writeRunResource({
      conversationId,
      kind: 'text',
      data: { text: 'shared' },
      producedBy,
    })) as RunResourceEntry;

    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        readRunResource(written.uri, { at: Date.now() + i, source: 'mcp-read', nodeId: `n${i}` })
      )
    );

    const [entry] = await listRunResources(conversationId);
    expect(entry.readBy.length).toBe(N);
  });
});
