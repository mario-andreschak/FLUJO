jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return { ...actual, openSync: jest.fn(actual.openSync), readSync: jest.fn(actual.readSync), closeSync: jest.fn(actual.closeSync) };
});
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));

import { openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanConversationLogSequence, getConversationSequenceScanDiagnostics } from '@/backend/execution/flow/conversationLogSequence';
import { allocateSeq, _setConversationLogDirForTests, getConversationSequenceDiagnostics } from '@/backend/execution/flow/conversationLog';

const disk = jest.requireActual<typeof import('node:fs')>('node:fs');
const ownedDescriptors = new Set<number>();
let directory: string;
let previous: string;
beforeEach(() => {
  directory = disk.mkdtempSync(path.join(os.tmpdir(), 'flujo-sequence-descriptors-'));
  previous = _setConversationLogDirForTests(directory);
  jest.mocked(openSync).mockReset().mockImplementation(((...args: Parameters<typeof disk.openSync>) => {
    expect(getConversationSequenceScanDiagnostics().scanActive).toBeGreaterThan(0);
    const descriptor = disk.openSync(...args);
    ownedDescriptors.add(descriptor);
    return descriptor;
  }) as typeof openSync);
  jest.mocked(readSync).mockReset().mockImplementation(disk.readSync);
  jest.mocked(closeSync).mockReset().mockImplementation(descriptor => {
    disk.closeSync(descriptor);
    ownedDescriptors.delete(descriptor);
  });
});
afterEach(() => {
  // Fault injection below throws BEFORE the real OS close. These exact test
  // descriptors remain owned; production never retries an ambiguous close.
  for (const descriptor of ownedDescriptors) disk.closeSync(descriptor);
  ownedDescriptors.clear();
  _setConversationLogDirForTests(previous);
  disk.rmSync(directory, { recursive: true, force: true });
});

it('releases cold slots after success, ENOENT, failed open, and a read failure with known close', () => {
  const file = path.join(directory, 'history.jsonl');
  disk.writeFileSync(file, '{"seq":7}\n');
  for (let count = 0; count < 8; count++) expect(scanConversationLogSequence(file)).toBe(7);
  expect(scanConversationLogSequence(path.join(directory, 'absent.jsonl'))).toBe(-1);
  jest.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  expect(() => scanConversationLogSequence(file)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO' }));
  jest.mocked(readSync).mockImplementationOnce(() => { throw new Error('read failed'); });
  expect(() => scanConversationLogSequence(file)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO' }));
  expect(ownedDescriptors.size).toBe(0);
  expect(getConversationSequenceScanDiagnostics()).toEqual({ scanActive: 0, scanQuarantined: 0, scanRefusals: 0, maxColdScans: 4 });
});

it('quarantines uncertain closes before further opens, preserves primary failure and existing sequence owners', () => {
  expect(allocateSeq('known-owner')).toBe(0);
  expect(allocateSeq('virtual:before')).toBe(0);
  jest.mocked(openSync).mockClear();
  const closeFailure = new Error('injected before OS close');
  const readFailure = new Error('primary scan read failure');
  jest.mocked(closeSync).mockImplementation(() => { throw closeFailure; });
  jest.mocked(readSync).mockImplementationOnce(() => { throw readFailure; });
  const maximum = getConversationSequenceScanDiagnostics().maxColdScans;
  for (let index = 0; index < maximum; index++) {
    const id = `uncertain-${index}`;
    disk.writeFileSync(path.join(directory, `${id}.jsonl`), '{"seq":7}\n');
    expect(() => allocateSeq(id)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_IO',
      cause: index === 0 ? readFailure : closeFailure }));
    expect(getConversationSequenceDiagnostics()).toMatchObject({ scanActive: 0, scanQuarantined: index + 1 });
  }
  for (let index = 0; index < 8; index++) {
    expect(() => allocateSeq(`refused-${index}`)).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_BUSY', status: 503 }));
  }
  expect(openSync).toHaveBeenCalledTimes(maximum);
  expect(closeSync).toHaveBeenCalledTimes(maximum);
  expect(ownedDescriptors.size).toBe(maximum);
  expect(allocateSeq('known-owner')).toBe(1);
  expect(allocateSeq('virtual:before')).toBe(1);
  expect(allocateSeq('virtual:after')).toBe(0);
  expect(getConversationSequenceDiagnostics()).toMatchObject({ scanActive: 0, scanQuarantined: maximum, scanRefusals: 8, keys: 3 });
  // Reloading a server bundle cannot forget quarantined descriptor ownership.
  jest.isolateModules(() => {
    const reloaded = require('@/backend/execution/flow/conversationLogSequence') as typeof import('@/backend/execution/flow/conversationLogSequence');
    expect(reloaded.getConversationSequenceScanDiagnostics().scanQuarantined).toBe(maximum);
    expect(() => reloaded.scanConversationLogSequence(path.join(directory, 'absent.jsonl')))
      .toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_SCAN_BUSY' }));
  });
  expect(openSync).toHaveBeenCalledTimes(maximum);
});
