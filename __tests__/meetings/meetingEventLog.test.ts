import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  _setMeetingEventLogDirForTests,
  appendMeetingEvent,
  appendMeetingEventBatch,
  deleteMeetingEventLog,
  latestMeetingSequence,
  readMeetingEvents,
} from '@/backend/services/meetings/eventLog';
import { MeetingEventBus } from '@/backend/services/meetings/MeetingEventBus';
import type { RawMeetingEvent } from '@/shared/types/meeting';

const created = (title: string, eventId?: string): RawMeetingEvent => ({
  type: 'meeting:created',
  audience: 'public',
  title,
  ...(eventId ? { eventId } : {}),
});

describe('meeting event log', () => {
  let tempDir: string;
  let previousDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-meeting-log-'));
    previousDir = _setMeetingEventLogDirForTests(tempDir);
  });

  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    _setMeetingEventLogDirForTests(tempDir);
  });

  afterAll(async () => {
    _setMeetingEventLogDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent appends into monotonic durable sequence order', async () => {
    const meetingId = 'concurrent-meeting';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        appendMeetingEvent(meetingId, created(`event-${index}`, `turn:${index}`))),
    );

    expect(results.map(({ event }) => event.seq)).toEqual(
      Array.from({ length: 30 }, (_, index) => index),
    );
    expect((await readMeetingEvents(meetingId)).map((event) => event.seq)).toEqual(
      Array.from({ length: 30 }, (_, index) => index),
    );
    expect(await latestMeetingSequence(meetingId)).toBe(29);
  });

  it('deduplicates a retried eventId and returns the original committed event', async () => {
    const first = await appendMeetingEvent('dedupe-meeting', created('Original', 'turn:alice:0'));
    const duplicate = await appendMeetingEvent('dedupe-meeting', created('Replacement', 'turn:alice:0'));

    expect(first.appended).toBe(true);
    expect(duplicate.appended).toBe(false);
    expect(duplicate.event).toEqual(first.event);
    expect(await readMeetingEvents('dedupe-meeting')).toHaveLength(1);
  });

  it('stores a round batch as one crash-atomic JSONL record', async () => {
    const meetingId = 'atomic-batch-meeting';
    await appendMeetingEvent(meetingId, created('Seed', 'seed'));
    const result = await appendMeetingEventBatch(meetingId, 'round:1:commit', [
      created('Alpha', 'alpha'),
      created('Beta', 'beta'),
      created('Complete', 'complete'),
    ]);

    expect(result.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    const file = path.join(tempDir, `${meetingId}.jsonl`);
    const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({
      kind: 'meeting-event-batch',
      batchId: 'round:1:commit',
    });

    // A torn final write invalidates the envelope line, so none of its child
    // events becomes visible and sequence allocation safely resumes at 1.
    await fs.writeFile(file, `${lines[0]}\n${lines[1].slice(0, -12)}`, 'utf8');
    _setMeetingEventLogDirForTests(tempDir);
    expect((await readMeetingEvents(meetingId)).map((event) => event.eventId)).toEqual(['seed']);
    const recovered = await appendMeetingEvent(meetingId, created('Recovered', 'recovered'));
    expect(recovered.event.seq).toBe(1);
  });

  it('resumes sequence allocation from disk after in-memory state is reset', async () => {
    await appendMeetingEvent('restart-meeting', created('Before restart', 'before'));
    _setMeetingEventLogDirForTests(tempDir);
    const after = await appendMeetingEvent('restart-meeting', created('After restart', 'after'));
    expect(after.event.seq).toBe(1);
  });

  it('skips a malformed crash-tail line and remains appendable', async () => {
    const meetingId = 'truncated-meeting';
    await appendMeetingEvent(meetingId, created('Complete', 'complete'));
    await fs.appendFile(path.join(tempDir, `${meetingId}.jsonl`), '{"truncated":', 'utf8');
    _setMeetingEventLogDirForTests(tempDir);

    expect(await readMeetingEvents(meetingId)).toHaveLength(1);
    const next = await appendMeetingEvent(meetingId, created('Recovered', 'recovered'));
    expect(next.event.seq).toBe(1);
    expect(await readMeetingEvents(meetingId)).toHaveLength(2);
  });

  it('rescans and accepts a full durable record when append reports failure', async () => {
    const meetingId = 'ambiguous-append-meeting';
    await appendMeetingEvent(meetingId, created('Seed', 'seed'));
    const originalAppendFile = fs.appendFile.bind(fs);
    const appendSpy = jest.spyOn(fs, 'appendFile');
    appendSpy.mockImplementationOnce(async (file, data, options) => {
      // Simulate an OS/filesystem error reported after the whole JSON record was
      // written but before its newline completion was acknowledged.
      await originalAppendFile(file, String(data).replace(/\n$/, ''), options);
      throw new Error('ambiguous append failure');
    });

    const recovered = await appendMeetingEvent(
      meetingId,
      created('Durable despite rejection', 'ambiguous'),
    ).finally(() => appendSpy.mockRestore());

    const retry = await appendMeetingEvent(
      meetingId,
      created('Retry must dedupe', 'ambiguous'),
    );
    const next = await appendMeetingEvent(meetingId, created('Next', 'next'));
    expect(recovered).toMatchObject({ appended: true, event: { seq: 1 } });
    expect(retry).toMatchObject({ appended: false, event: { seq: 1 } });
    expect(next.event.seq).toBe(2);
    expect((await readMeetingEvents(meetingId)).map((event) => event.eventId))
      .toEqual(['seed', 'ambiguous', 'next']);
  });

  it('separates a torn rejected append before safely reusing its sequence', async () => {
    const meetingId = 'torn-rejected-append-meeting';
    await appendMeetingEvent(meetingId, created('Seed', 'seed'));
    const originalAppendFile = fs.appendFile.bind(fs);
    const appendSpy = jest.spyOn(fs, 'appendFile');
    appendSpy.mockImplementationOnce(async (file, data, options) => {
      await originalAppendFile(file, String(data).slice(0, 24), options);
      throw new Error('torn append failure');
    });

    await expect(appendMeetingEvent(
      meetingId,
      created('Torn', 'torn'),
    )).rejects.toThrow('torn append failure');
    appendSpy.mockRestore();

    const next = await appendMeetingEvent(meetingId, created('Next', 'next'));
    expect(next.event.seq).toBe(1);
    expect((await readMeetingEvents(meetingId)).map((event) => event.eventId))
      .toEqual(['seed', 'next']);
  });

  it('rejects unsafe meeting ids and deletes idempotently', async () => {
    await expect(appendMeetingEvent('../outside', created('Nope'))).rejects.toThrow(/unsafe/i);
    expect(await fs.readdir(tempDir)).toEqual([]);

    await appendMeetingEvent('delete-meeting', created('Delete me'));
    await deleteMeetingEventLog('delete-meeting');
    await expect(deleteMeetingEventLog('delete-meeting')).resolves.toBeUndefined();
    expect(await readMeetingEvents('delete-meeting')).toEqual([]);
  });

  it('supports inclusive cursors and bounded reads', async () => {
    await appendMeetingEvent('cursor-meeting', created('zero'));
    await appendMeetingEvent('cursor-meeting', created('one'));
    await appendMeetingEvent('cursor-meeting', created('two'));
    expect((await readMeetingEvents('cursor-meeting', { fromSeq: 1, limit: 1 }))[0].seq).toBe(1);
  });
});

describe('MeetingEventBus', () => {
  let tempDir: string;
  let previousDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-meeting-bus-'));
    previousDir = _setMeetingEventLogDirForTests(tempDir);
  });

  beforeEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    _setMeetingEventLogDirForTests(tempDir);
  });

  afterAll(async () => {
    _setMeetingEventLogDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('publishes only after persistence and does not republish idempotent retries', async () => {
    const bus = new MeetingEventBus();
    const received: string[] = [];
    bus.subscribe('live-meeting', (event) => received.push(event.eventId));

    const first = await bus.emit('live-meeting', created('One', 'stable:event'));
    const duplicate = await bus.emit('live-meeting', created('Ignored', 'stable:event'));

    expect(first).toEqual(duplicate);
    expect(received).toEqual(['stable:event']);
    expect(await readMeetingEvents('live-meeting')).toEqual([first]);
  });

  it('publishes a fully written ambiguous append exactly once', async () => {
    const meetingId = 'ambiguous-live-meeting';
    const bus = new MeetingEventBus();
    const received: string[] = [];
    bus.subscribe(meetingId, (event) => received.push(event.eventId));
    const originalAppendFile = fs.appendFile.bind(fs);
    const appendSpy = jest.spyOn(fs, 'appendFile');
    appendSpy.mockImplementationOnce(async (file, data, options) => {
      await originalAppendFile(file, String(data).replace(/\n$/, ''), options);
      throw new Error('ambiguous append failure');
    });

    const first = await bus.emit(
      meetingId,
      created('Durable terminal equivalent', 'stable:ambiguous'),
    ).finally(() => appendSpy.mockRestore());
    const retry = await bus.emit(
      meetingId,
      created('Retry', 'stable:ambiguous'),
    );

    expect(first).toEqual(retry);
    expect(received).toEqual(['stable:ambiguous']);
    expect((await readMeetingEvents(meetingId)).map((event) => event.eventId))
      .toEqual(['stable:ambiguous']);
  });

  it('publishes an atomic batch in order and does not republish a retry', async () => {
    const bus = new MeetingEventBus();
    const received: string[] = [];
    bus.subscribe('batch-live-meeting', (event) => received.push(event.eventId));
    const raws = [created('Alpha', 'alpha'), created('Beta', 'beta')];

    const first = await bus.emitBatch('batch-live-meeting', 'round:1:commit', raws);
    const retry = await bus.emitBatch('batch-live-meeting', 'round:1:commit', raws);

    expect(retry).toEqual(first);
    expect(received).toEqual(['alpha', 'beta']);
    expect((await readMeetingEvents('batch-live-meeting')).map((event) => event.eventId))
      .toEqual(['alpha', 'beta']);
  });

  it('uses the ring buffer when covered and durable fallback after eviction', async () => {
    const bus = new MeetingEventBus(2);
    await bus.emit('replay-meeting', created('zero', 'e0'));
    await bus.emit('replay-meeting', created('one', 'e1'));
    await bus.emit('replay-meeting', created('two', 'e2'));

    expect(bus.getBufferedSince('replay-meeting', 0).map((event) => event.seq)).toEqual([1, 2]);
    expect((await bus.replaySince('replay-meeting', 1)).map((event) => event.seq)).toEqual([1, 2]);
    expect((await bus.replaySince('replay-meeting', 0)).map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it('does not let a historical retry create a gapped replay buffer after restart', async () => {
    const meetingId = 'restart-retry-replay-meeting';
    const originalBus = new MeetingEventBus();
    for (let index = 0; index < 5; index++) {
      await originalBus.emit(meetingId, created(`event-${index}`, `event:${index}`));
    }

    const restartedBus = new MeetingEventBus();
    await restartedBus.emit(meetingId, created('historical retry', 'event:0'));

    expect(restartedBus.getBufferedSince(meetingId, 0)).toEqual([]);
    expect((await restartedBus.replaySince(meetingId, 2)).map((event) => event.seq))
      .toEqual([2, 3, 4]);
  });

  it('isolates throwing listeners and provides idempotent unsubscription', async () => {
    const bus = new MeetingEventBus();
    const received: number[] = [];
    bus.subscribe('listeners-meeting', () => { throw new Error('listener failure'); });
    const unsubscribe = bus.subscribe('listeners-meeting', (event) => received.push(event.seq));

    await expect(bus.emit('listeners-meeting', created('one'))).resolves.toMatchObject({ seq: 0 });
    unsubscribe();
    unsubscribe();
    await bus.emit('listeners-meeting', created('two'));
    expect(received).toEqual([0]);
  });
});
