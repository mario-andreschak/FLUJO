import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  _getPersonaRuntimeEventLogPathsForTests,
  _getPersonaRuntimeEventLogStatsForTests,
  _getPersonaRuntimeEventLogStateForTests,
  _resetPersonaRuntimeEventLogStatsForTests,
  _setPersonaRuntimeEventIdempotencyWindowForTests,
  _setPersonaRuntimeEventLogRootForTests,
  appendPersonaRuntimeEvent,
  latestPersonaRuntimeEventSequence,
  PERSONA_RUNTIME_EVENT_VERSION,
  readPersonaRuntimeEvents,
} from '@/backend/services/enduringAgents/runtimeEvents';
import { runWithWorkspace } from '@/utils/workspace';

jest.setTimeout(120_000);

let workspaceSequence = 0;

function freshWorkspace(label: string): string {
  workspaceSequence += 1;
  return `runtime-incr-${label}-${process.pid}-${workspaceSequence}`;
}

function activeEventFile(personaId: string): string {
  const file = _getPersonaRuntimeEventLogPathsForTests(personaId).activeSegment;
  if (!file) throw new Error(`No active runtime-event segment for ${personaId}.`);
  return file;
}

function completedEvent(index: number, prefix = 'incr') {
  return {
    eventId: `${prefix}:${index}`,
    type: 'activity:completed' as const,
    activityId: `activity_${prefix}_${index}`,
  };
}

function foreignLine(
  workspace: string,
  personaId: string,
  seq: number,
  eventId: string,
  activityId = `activity_foreign_${seq}`,
): string {
  return `${JSON.stringify({
    eventId,
    type: 'activity:completed',
    activityId,
    version: PERSONA_RUNTIME_EVENT_VERSION,
    workspaceId: workspace,
    personaId,
    seq,
    timestamp: Date.now(),
  })}\n`;
}

describe('Persona runtime event log incremental state (#454)', () => {
  let tempRoot: string;
  let previousRoot: string | undefined;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runtime-events-incr-'));
    previousRoot = _setPersonaRuntimeEventLogRootForTests(tempRoot);
  });

  beforeEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    await fs.mkdir(tempRoot, { recursive: true });
    _setPersonaRuntimeEventLogRootForTests(tempRoot);
    _resetPersonaRuntimeEventLogStatsForTests();
  });

  afterEach(() => {
    _setPersonaRuntimeEventIdempotencyWindowForTests(undefined);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    _setPersonaRuntimeEventLogRootForTests(previousRoot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('re-reads zero bytes on repeat appends (stat-gated cache hit path)', async () => {
    await runWithWorkspace(freshWorkspace('cachehit'), async () => {
      const personaId = 'persona_cache_hit';
      _resetPersonaRuntimeEventLogStatsForTests();
      const results = [];
      for (let index = 0; index < 50; index += 1) {
        results.push(await appendPersonaRuntimeEvent(personaId, completedEvent(index)));
      }
      expect(results.map(({ event }) => event.seq))
        .toEqual(Array.from({ length: 50 }, (_, index) => index));
      const stats = _getPersonaRuntimeEventLogStatsForTests();
      // First append hits the ENOENT fast path; appends 2..50 are O(1) hits.
      expect(stats.fullRescans).toBe(0);
      expect(stats.tailReads).toBe(0);
      expect(stats.bytesParsed).toBe(0);
      expect(stats.linesParsed).toBe(0);
      expect(stats.cacheHits).toBe(49);
    });
  });

  it('detects a foreign append via file growth and parses only the delta bytes', async () => {
    const workspace = freshWorkspace('foreign');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_foreign';
      await appendPersonaRuntimeEvent(personaId, completedEvent(0));

      const file = activeEventFile(personaId);
      const foreign = foreignLine(workspace, personaId, 1, 'foreign:1');
      await fs.appendFile(file, foreign, 'utf8');

      _resetPersonaRuntimeEventLogStatsForTests();
      const next = await appendPersonaRuntimeEvent(personaId, completedEvent(2));
      // No seq collision: the foreign event advanced the sequence.
      expect(next.event.seq).toBe(2);

      const stats = _getPersonaRuntimeEventLogStatsForTests();
      expect(stats.fullRescans).toBe(0);
      expect(stats.tailReads).toBe(1);
      // Only the foreign delta was read and parsed — not the whole log.
      expect(stats.bytesParsed).toBe(Buffer.byteLength(foreign, 'utf8'));
      expect(stats.linesParsed).toBe(1);

      expect((await readPersonaRuntimeEvents(personaId)).map(({ seq }) => seq))
        .toEqual([0, 1, 2]);
    });
  });

  it('deduplicates a retried eventId that a foreign process already made durable', async () => {
    const workspace = freshWorkspace('foreigndup');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_foreign_dup';
      await appendPersonaRuntimeEvent(personaId, completedEvent(0));

      const file = activeEventFile(personaId);
      await fs.appendFile(file, foreignLine(workspace, personaId, 1, 'dup:1'), 'utf8');

      const retry = await appendPersonaRuntimeEvent(personaId, {
        eventId: 'dup:1',
        type: 'activity:completed' as const,
        activityId: 'activity_retry_ignored',
      });
      expect(retry.appended).toBe(false);
      expect(retry.event.seq).toBe(1);
      expect(retry.event).toMatchObject({ activityId: 'activity_foreign_1' });
    });
  });

  it('forces a full rescan when the file shrinks (truncation)', async () => {
    const workspace = freshWorkspace('shrink');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_shrink';
      for (let index = 0; index < 3; index += 1) {
        await appendPersonaRuntimeEvent(personaId, completedEvent(index));
      }
      const file = activeEventFile(personaId);
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      await fs.writeFile(file, `${lines[0]}\n`, 'utf8');

      _resetPersonaRuntimeEventLogStatsForTests();
      const next = await appendPersonaRuntimeEvent(personaId, completedEvent(9));
      // The manifest is the durable sequence authority. Truncating the active
      // segment must not cause an already-issued sequence number to be reused.
      expect(next.event.seq).toBe(3);
      expect(_getPersonaRuntimeEventLogStatsForTests().fullRescans).toBe(1);
      expect((await readPersonaRuntimeEvents(personaId)).map(({ seq }) => seq)).toEqual([0, 3]);
    });
  });

  it('forces a full rescan when the file is replaced (inode change, same byte length)', async () => {
    const workspace = freshWorkspace('replace');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_replace';
      await appendPersonaRuntimeEvent(personaId, completedEvent(0));
      await appendPersonaRuntimeEvent(personaId, completedEvent(1));

      const file = activeEventFile(personaId);
      const original = await fs.readFile(file, 'utf8');
      // Same byte length, different content: only (dev, ino) can catch this.
      const replaced = original.replace('"seq":1', '"seq":7');
      expect(Buffer.byteLength(replaced, 'utf8')).toBe(Buffer.byteLength(original, 'utf8'));
      await fs.unlink(file);
      await fs.writeFile(file, replaced, 'utf8');

      _resetPersonaRuntimeEventLogStatsForTests();
      const next = await appendPersonaRuntimeEvent(personaId, completedEvent(9));
      expect(next.event.seq).toBe(8);
      expect(_getPersonaRuntimeEventLogStatsForTests().fullRescans).toBe(1);
    });
  });

  it('never advances the cached offset past a crash fragment and heals it with a separator', async () => {
    const workspace = freshWorkspace('crashtail');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_crash_tail';
      await appendPersonaRuntimeEvent(personaId, completedEvent(0));
      const stateAfterFirst = _getPersonaRuntimeEventLogStateForTests(personaId);
      expect(stateAfterFirst).toBeDefined();
      const parsedBeforeFragment = stateAfterFirst!.parsedBytes;

      const file = activeEventFile(personaId);
      await fs.appendFile(file, '{"truncated":', 'utf8');

      const next = await appendPersonaRuntimeEvent(personaId, completedEvent(1));
      expect(next.event.seq).toBe(1);

      const state = _getPersonaRuntimeEventLogStateForTests(personaId);
      expect(state).toBeDefined();
      // The offset skipped over the fragment only once it was newline-terminated.
      expect(state!.parsedBytes).toBeGreaterThan(parsedBeforeFragment);
      expect(state!.parsedBytes).toBe(Number((await fs.stat(file)).size));
      expect(state!.tailBytesLength).toBe(0);
      expect(state!.needsSeparator).toBe(false);

      const content = await fs.readFile(file, 'utf8');
      expect(content).toContain('{"truncated":\n');
      expect((await readPersonaRuntimeEvents(personaId)).map(({ eventId }) => eventId))
        .toEqual(['incr:0', 'incr:1']);
    });
  });

  it('keeps exact byte offsets across multi-byte UTF-8 foreign content', async () => {
    const workspace = freshWorkspace('utf8');
    await runWithWorkspace(workspace, async () => {
      const personaId = 'persona_utf8';
      await appendPersonaRuntimeEvent(personaId, completedEvent(0));

      const file = activeEventFile(personaId);
      // A parseable but workspace-mismatched line with multi-byte UTF-8 content
      // (skipped), plus a malformed multi-byte fragment terminated later — the
      // cached offset must still equal the true on-disk byte size afterwards.
      await fs.appendFile(
        file,
        `${foreignLine('wörk-späce-üñí-⚙️', personaId, 3, 'utf8:mismatch')}{"später":"näh…`,
        'utf8',
      );

      const next = await appendPersonaRuntimeEvent(personaId, completedEvent(1));
      expect(next.event.seq).toBe(1);
      const state = _getPersonaRuntimeEventLogStateForTests(personaId);
      expect(state).toBeDefined();
      expect(state!.parsedBytes).toBe(Number((await fs.stat(file)).size));
      expect(state!.tailBytesLength).toBe(0);
    });
  });

  it('isolates cached state by workspace and by test root', async () => {
    const workspaceA = freshWorkspace('iso-a');
    const workspaceB = freshWorkspace('iso-b');
    const personaId = 'persona_isolated';
    const append = (workspace: string) => runWithWorkspace(workspace, () =>
      appendPersonaRuntimeEvent(personaId, completedEvent(0, `iso-${workspace}`)));

    const first = await append(workspaceA);
    const second = await append(workspaceB);
    expect(first.event.seq).toBe(0);
    expect(second.event.seq).toBe(0);
    expect(first.event.workspaceId).toBe(workspaceA);
    expect(second.event.workspaceId).toBe(workspaceB);

    // Swapping the test root must reset in-process state entirely.
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runtime-events-incr-b-'));
    try {
      _setPersonaRuntimeEventLogRootForTests(otherRoot);
      const fresh = await runWithWorkspace(workspaceA, () =>
        appendPersonaRuntimeEvent(personaId, completedEvent(0, 'iso-freshroot')));
      expect(fresh.event.seq).toBe(0);
    } finally {
      _setPersonaRuntimeEventLogRootForTests(tempRoot);
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('bounds the idempotency window and codifies out-of-window retry semantics', async () => {
    await runWithWorkspace(freshWorkspace('window'), async () => {
      const personaId = 'persona_window';
      const previous = _setPersonaRuntimeEventIdempotencyWindowForTests(5);
      try {
        for (let index = 0; index < 8; index += 1) {
          await appendPersonaRuntimeEvent(personaId, completedEvent(index, 'win'));
        }
        const state = _getPersonaRuntimeEventLogStateForTests(personaId);
        expect(state).toBeDefined();
        expect(state!.windowSize).toBeLessThanOrEqual(5);

        // A retry inside the window is deduplicated exactly as before.
        const recent = await appendPersonaRuntimeEvent(personaId, completedEvent(7, 'win'));
        expect(recent).toMatchObject({ appended: false, event: { seq: 7 } });

        // DOCUMENTED SEMANTIC CHANGE (#454): a duplicate eventId older than
        // the window is no longer detected and appends a new record with a
        // new seq. Reads still suppress the duplicated id (first one wins).
        const stale = await appendPersonaRuntimeEvent(personaId, completedEvent(0, 'win'));
        expect(stale.appended).toBe(true);
        expect(stale.event.seq).toBe(8);

        const events = await readPersonaRuntimeEvents(personaId);
        expect(events.map(({ seq }) => seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      } finally {
        _setPersonaRuntimeEventIdempotencyWindowForTests(previous);
      }
    });
  });

  it('preserves read semantics for fromSeq/limit and supports the new tail option', async () => {
    await runWithWorkspace(freshWorkspace('read'), async () => {
      const personaId = 'persona_read';
      for (let index = 0; index < 10; index += 1) {
        await appendPersonaRuntimeEvent(personaId, completedEvent(index, 'read'));
      }
      const seqs = async (options?: Parameters<typeof readPersonaRuntimeEvents>[1]) =>
        (await readPersonaRuntimeEvents(personaId, options)).map(({ seq }) => seq);

      expect(await seqs()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(await seqs({ fromSeq: 4 })).toEqual([4, 5, 6, 7, 8, 9]);
      expect(await seqs({ limit: 3 })).toEqual([0, 1, 2]);
      expect(await seqs({ fromSeq: 4, limit: 2 })).toEqual([4, 5]);
      expect(await seqs({ limit: 0 })).toEqual([]);
      expect(await seqs({ tail: 3 })).toEqual([7, 8, 9]);
      expect(await seqs({ tail: 3, fromSeq: 8 })).toEqual([8, 9]);
      expect(await seqs({ tail: 0 })).toEqual([]);
      expect(await seqs({ tail: 4, limit: 2 })).toEqual([6, 7]);

      expect(await latestPersonaRuntimeEventSequence(personaId)).toBe(9);
      expect(await latestPersonaRuntimeEventSequence('persona_read_empty')).toBe(-1);
      expect(await readPersonaRuntimeEvents('persona_read_empty')).toEqual([]);
    });
  });
});
