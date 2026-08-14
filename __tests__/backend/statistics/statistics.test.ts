import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  _setStatisticsDirForTests,
  anonymizeStatisticsPersonaAttribution,
  appendStatisticsEvent,
  createStatisticsEvent,
  credentialFingerprint,
  flushStatisticsEvents,
  readStatisticsEvents,
  recordStatisticsEvent,
} from '@/backend/services/statistics';
import {
  sanitizeStatisticsEvent,
  STATISTICS_SCHEMA_VERSION,
  type StatisticsEvent,
} from '@/shared/types/statistics';

describe('metadata-only statistics store', () => {
  let tempDir: string;
  let previousDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-statistics-'));
    previousDir = _setStatisticsDirForTests(tempDir);
  });

  afterEach(async () => {
    await flushStatisticsEvents();
    _setStatisticsDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const runStarted = (runId: string, timestamp = '2026-07-30T12:00:00.000Z') =>
    createStatisticsEvent({
      type: 'run.started',
      runId,
      timestamp,
      source: 'chat',
      flow: { id: 'flow-1', name: 'Flow One' },
      conversationId: 'conversation-1',
    });

  it('validates schema versions and rebuilds records from the metadata allowlist', () => {
    const event = sanitizeStatisticsEvent({
      ...runStarted('run-1'),
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
        prompt: 'ATTRIBUTION_CANARY',
      },
      prompt: 'PROMPT_CANARY',
      response: 'RESPONSE_CANARY',
      toolArguments: 'ARGS_CANARY',
      rawError: 'ERROR_CANARY',
      apiKey: 'KEY_CANARY',
      requestUrl: 'https://secret.example.test/path',
    });

    expect(event).toEqual(expect.objectContaining({
      schemaVersion: STATISTICS_SCHEMA_VERSION,
      type: 'run.started',
      runId: 'run-1',
      personaAttribution: {
        personaId: 'persona-1',
        activityId: 'activity-1',
        behaviorRevisionId: 'behavior-revision-1',
      },
    }));
    expect(JSON.stringify(event)).not.toMatch(
      /ATTRIBUTION_CANARY|PROMPT_CANARY|RESPONSE_CANARY|ARGS_CANARY|ERROR_CANARY|KEY_CANARY|secret\.example/,
    );
    expect(sanitizeStatisticsEvent({ ...runStarted('run-2'), schemaVersion: 99 })).toBeUndefined();
    expect(sanitizeStatisticsEvent({
      ...runStarted('run-3'),
      personaAttribution: { personaId: '../unsafe' },
    })).not.toHaveProperty('personaAttribution');
  });

  it('allowlists scheduler fire metadata without persisting trigger content', () => {
    const queued = createStatisticsEvent({
      type: 'scheduler.fire',
      runId: 'scheduled-run-1',
      timestamp: '2026-07-30T12:00:00.000Z',
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
      outcome: 'queued',
    });
    const fired = sanitizeStatisticsEvent({
      ...queued,
      outcome: 'fired',
      conversationId: 'ephemeral-conversation-1',
      prompt: 'PROMPT_CANARY',
      triggerContext: 'TRIGGER_CONTEXT_CANARY',
      rawError: 'ERROR_CANARY',
      requestUrl: 'https://secret.example.test/scheduler',
    });

    expect(queued).not.toHaveProperty('conversationId');
    expect(fired).toEqual(expect.objectContaining({
      type: 'scheduler.fire',
      runId: 'scheduled-run-1',
      outcome: 'fired',
      conversationId: 'ephemeral-conversation-1',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
    }));
    expect(JSON.stringify(fired)).not.toMatch(
      /PROMPT_CANARY|TRIGGER_CONTEXT_CANARY|ERROR_CANARY|secret\.example/,
    );
    expect(sanitizeStatisticsEvent({ ...queued, outcome: 'suppressed' })).toBeUndefined();
  });

  it('partitions by UTC day and preserves same-day concurrent append order', async () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      runStarted(`run-${index}`, `2026-07-30T12:00:${String(index).padStart(2, '0')}.000Z`),
    );
    const nextDay = runStarted('next-day', '2026-07-31T00:00:00.000Z');

    await Promise.all([
      ...events.map(event => appendStatisticsEvent(event)),
      appendStatisticsEvent(nextDay),
    ]);

    await expect(readStatisticsEvents('2026-07-30')).resolves.toEqual(events);
    await expect(readStatisticsEvents('2026-07-31')).resolves.toEqual([nextDay]);
    await expect(fs.readdir(tempDir)).resolves.toEqual(expect.arrayContaining([
      '2026-07-30.jsonl',
      '2026-07-31.jsonl',
    ]));
  });

  it('keeps a queued append bound to the data root resolved at enqueue time', async () => {
    const originalDataDir = process.env.FLUJO_DATA_DIR;
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-statistics-root-a-'));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-statistics-root-b-'));
    _setStatisticsDirForTests(undefined);

    try {
      process.env.FLUJO_DATA_DIR = firstRoot;
      const pending = appendStatisticsEvent(runStarted('enqueue-root'));

      // The append operation runs in a promise continuation. Simulate Jest or
      // runtime teardown restoring the inherited root before that continuation.
      process.env.FLUJO_DATA_DIR = secondRoot;
      await pending;

      const relativeFile = path.join(
        'workspaces',
        'default-workspace',
        'db',
        'statistics',
        '2026-07-30.jsonl',
      );
      await expect(fs.readFile(path.join(firstRoot, relativeFile), 'utf8'))
        .resolves.toContain('enqueue-root');
      await expect(fs.stat(path.join(secondRoot, relativeFile))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      process.env.FLUJO_DATA_DIR = originalDataDir;
      _setStatisticsDirForTests(tempDir);
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it('flushes events enqueued while an earlier append is still pending', async () => {
    const appendFile = fs.appendFile.bind(fs);
    let appendCount = 0;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let signalFirstStarted!: () => void;
    let signalSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const appendSpy = jest.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      appendCount += 1;
      if (appendCount === 1) {
        signalFirstStarted();
        await firstGate;
      } else if (appendCount === 2) {
        signalSecondStarted();
        await secondGate;
      }
      return appendFile(...args);
    });

    try {
      const first = appendStatisticsEvent(runStarted('flush-first'));
      await firstStarted;
      const flushing = flushStatisticsEvents();
      const second = appendStatisticsEvent(runStarted('flush-second'));

      releaseFirst();
      await secondStarted;
      let flushResolved = false;
      void flushing.then(() => { flushResolved = true; });
      await Promise.resolve();
      expect(flushResolved).toBe(false);

      releaseSecond();
      await expect(flushing).resolves.toBeUndefined();
      await Promise.all([first, second]);
      await expect(readStatisticsEvents('2026-07-30')).resolves.toEqual([
        expect.objectContaining({ runId: 'flush-first' }),
        expect.objectContaining({ runId: 'flush-second' }),
      ]);
    } finally {
      releaseFirst();
      releaseSecond();
      appendSpy.mockRestore();
    }
  });

  it('atomically and idempotently anonymizes only one Persona across queued partitions', async () => {
    const target = {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'behavior-revision-1',
    };
    const other = {
      personaId: 'persona-2',
      activityId: 'activity-2',
      behaviorRevisionId: 'behavior-revision-2',
    };
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'run.started',
      runId: 'run-other',
      timestamp: '2026-07-30T09:00:00.000Z',
      source: 'api',
      flow: { id: 'flow-other' },
      personaAttribution: other,
    }));
    await fs.appendFile(
      path.join(tempDir, '2026-07-30.jsonl'),
      '{unrelated-corrupt-line}\n{"schemaVersion":1,"personaAttribution":{"personaId":"persona-1"\n',
      'utf8',
    );

    // Do not await these appends. The anonymizer must first drain the existing
    // per-partition chains, including a partition that does not exist yet.
    const pending = [
      appendStatisticsEvent(createStatisticsEvent({
        type: 'run.started',
        runId: 'run-target',
        timestamp: '2026-07-30T10:00:00.000Z',
        source: 'api',
        flow: { id: 'flow-target' },
        personaAttribution: target,
      })),
      appendStatisticsEvent(createStatisticsEvent({
        type: 'run.finished',
        runId: 'run-target',
        timestamp: '2026-07-31T10:00:01.000Z',
        source: 'api',
        flow: { id: 'flow-target' },
        outcome: 'completed',
        durationMs: 1,
        personaAttribution: target,
      })),
    ];

    await expect(anonymizeStatisticsPersonaAttribution('persona-1')).resolves.toBe(3);
    await Promise.all(pending);

    const dayOne = await readStatisticsEvents('2026-07-30');
    const dayTwo = await readStatisticsEvents('2026-07-31');
    expect(dayOne.find((event) => event.runId === 'run-other')?.personaAttribution).toEqual(other);
    expect(dayOne.find((event) => event.runId === 'run-target')).not.toHaveProperty('personaAttribution');
    expect(dayTwo).toHaveLength(1);
    expect(dayTwo[0]).not.toHaveProperty('personaAttribution');

    const paths = ['2026-07-30.jsonl', '2026-07-31.jsonl'].map((file) => path.join(tempDir, file));
    const beforeRetry = await Promise.all(paths.map((file) => fs.readFile(file, 'utf8')));
    expect(beforeRetry[0]).toContain('{unrelated-corrupt-line}');
    expect(beforeRetry.join('\n')).not.toContain('persona-1');
    expect(beforeRetry.join('\n')).toContain('persona-2');

    await expect(anonymizeStatisticsPersonaAttribution('persona-1')).resolves.toBe(0);
    await expect(Promise.all(paths.map((file) => fs.readFile(file, 'utf8'))))
      .resolves.toEqual(beforeRetry);
  });

  it('strips unexpected content fields before serialized persistence', async () => {
    const event = {
      ...runStarted('run-private'),
      prompt: 'PROMPT_CANARY',
      response: 'RESPONSE_CANARY',
      args: { secret: 'ARGS_CANARY' },
      result: 'RESULT_CANARY',
      url: 'https://private.example.test',
      error: { body: 'RAW_ERROR_CANARY' },
      encryptedApiKey: 'ENCRYPTED_KEY_CANARY',
    } as StatisticsEvent & Record<string, unknown>;

    await appendStatisticsEvent(event);
    const body = await fs.readFile(path.join(tempDir, '2026-07-30.jsonl'), 'utf8');

    expect(body).not.toMatch(
      /PROMPT_CANARY|RESPONSE_CANARY|ARGS_CANARY|RESULT_CANARY|private\.example|RAW_ERROR_CANARY|ENCRYPTED_KEY_CANARY/,
    );
    expect(JSON.parse(body)).toEqual(runStartedShape(event));
  });

  it('recovers valid records around corrupt middle lines and a truncated tail', async () => {
    const first = runStarted('first');
    const second = runStarted('second');
    await fs.writeFile(
      path.join(tempDir, '2026-07-30.jsonl'),
      `${JSON.stringify(first)}\n{not-json}\n${JSON.stringify(second)}\n{"schemaVersion":1`,
      'utf8',
    );

    await expect(readStatisticsEvents('2026-07-30')).resolves.toEqual([first, second]);
  });

  it('keeps append failures best-effort and isolated from callers', async () => {
    const blockedPath = path.join(tempDir, 'not-a-directory');
    await fs.writeFile(blockedPath, 'occupied', 'utf8');
    _setStatisticsDirForTests(blockedPath);

    expect(() => recordStatisticsEvent(runStarted('best-effort'))).not.toThrow();
    await expect(flushStatisticsEvents()).resolves.toBeUndefined();

    _setStatisticsDirForTests(tempDir);
    await expect(appendStatisticsEvent(runStarted('after-failure'))).resolves.toBeUndefined();
    await expect(readStatisticsEvents('2026-07-30')).resolves.toHaveLength(1);
  });

  it('creates stable installation-local credential groups without storing credentials', async () => {
    const secretA = 'sk-live-first-canary';
    const secretB = 'sk-live-second-canary';

    const first = await credentialFingerprint(secretA);
    const again = await credentialFingerprint(secretA);
    const different = await credentialFingerprint(secretB);

    expect(first).toMatch(/^cred_[A-Za-z0-9_-]{22}$/);
    expect(again).toBe(first);
    expect(different).not.toBe(first);
    const keyBytes = await fs.readFile(path.join(tempDir, '.installation-key'));
    expect(keyBytes.toString('utf8')).not.toContain(secretA);
    expect(keyBytes.toString('utf8')).not.toContain(secretB);
  });
});

function runStartedShape(event: StatisticsEvent): StatisticsEvent {
  const sanitized = sanitizeStatisticsEvent(event);
  if (!sanitized) throw new Error('Expected a valid statistics event');
  return sanitized;
}
