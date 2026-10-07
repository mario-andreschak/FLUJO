import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
  withPersonaRuntimeLock,
  type PersonaRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import {
  _setPersonaRuntimeClockForTests,
  type PersonaRuntimeClock,
} from '@/backend/services/enduringAgents/runtimeClock';

// Exercise the real filesystem acquisition/retirement primitive. The existing
// workspace admission and process suites retain coverage of the outer queues.
jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
}));
jest.mock('@/utils/workspace', () => ({
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  getCurrentWorkspace: () => 'coordination-scan-test',
  getWorkspaceDbDir: () => mockDbDir,
}));

const marker = 'win32-v2:638927322190000000';
const personaId = 'persona_coordination_scan';
const foreignOwnerId = '00000000-0000-4000-8000-000000000101';
const intentOwnerId = '00000000-0000-4000-8000-000000000102';
let mockDbDir: string;
let lockRoot: string;
let lockPath: string;
let savedIdentity: Promise<string | null> | undefined;
let savedClock: PersonaRuntimeClock | undefined;
let elapsed: number;
let sleep: jest.Mock<Promise<void>, [number]>;

function foreignOwner(ownerId: string) {
  return {
    ownerId,
    processInstanceId: 'separate-isolate-with-the-same-live-pid',
    pid: process.pid,
    processBirthMarkerV2: marker,
    workspace: 'coordination-scan-test',
    acquiredAt: 0,
  };
}

beforeEach(async () => {
  mockDbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-lock-coordination-scan-'));
  lockRoot = path.join(mockDbDir, '.runtime-locks', 'enduring-agents');
  lockPath = path.join(lockRoot, personaId + '.lock');
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve(marker);
  elapsed = 0;
  sleep = jest.fn(async (ms: number) => { elapsed += ms; });
  savedClock = _setPersonaRuntimeClockForTests({
    now: () => elapsed,
    monotonicNow: () => elapsed,
    sleep,
    setTimer: () => { throw new Error('Unexpected deferred cleanup in coordination scan test.'); },
  });
});

afterEach(async () => {
  global.__flujo_enduring_agent_process_birth_marker_v2 = savedIdentity;
  _setPersonaRuntimeClockForTests(savedClock);
  jest.restoreAllMocks();
  if (
    path.dirname(path.resolve(mockDbDir)) !== path.resolve(os.tmpdir())
    || !path.basename(mockDbDir).startsWith('flujo-lock-coordination-scan-')
  ) throw new Error('Unexpected test-owned directory.');
  await fs.rm(mockDbDir, { recursive: true, force: true });
});

describe('Persona lock acquisition directory observations', () => {
  it('takes separate fresh pre/post listings on every acquisition', async () => {
    const scans = jest.spyOn(fs, 'readdir');
    for (const result of ['first', 'second']) {
      await expect(withPersonaRuntimeLock(personaId, async (lock) => {
        await lock.assertOwned();
        return result;
      })).resolves.toBe(result);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(scans.mock.calls.filter(([directory]) => String(directory) === lockRoot))
      .toHaveLength(4);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits for a recovery intent appearing during installation and rechecks the installed owner', async () => {
    const originalLink = fs.link.bind(fs);
    const intentPath = lockPath + '.recovery.' + intentOwnerId;
    const protectedWork = jest.fn(async (lock: PersonaRuntimeLock) => {
      await lock.assertOwned();
      return 'owned';
    });
    let canonicalInstallations = 0;
    jest.spyOn(fs, 'link').mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (String(target) !== lockPath) return;
      canonicalInstallations += 1;
      if (canonicalInstallations !== 1) return;
      const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      await fs.writeFile(intentPath, JSON.stringify({
        ...foreignOwner(intentOwnerId),
        targetOwnerId: owner.ownerId,
        targetProcessInstanceId: owner.processInstanceId,
        targetPid: owner.pid,
      }), { flag: 'wx' });
    });
    sleep.mockImplementationOnce(async (ms) => {
      expect(protectedWork).not.toHaveBeenCalled();
      // Model the delayed predecessor recovery syscall completing while its
      // live intent still bars entry. The successor must reinstall its owner.
      await fs.unlink(lockPath);
      await fs.unlink(intentPath);
      elapsed += ms;
    });

    await expect(withPersonaRuntimeLock(personaId, protectedWork)).resolves.toBe('owned');
    expect(canonicalInstallations).toBe(2);
    expect(protectedWork).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls).toEqual([[25]]);
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('classifies explicit abandonment and recovery records from the same listing without treating candidates as intents', async () => {
    await fs.mkdir(lockRoot, { recursive: true });
    const owner = foreignOwner(foreignOwnerId);
    const intent = {
      ...foreignOwner(intentOwnerId),
      targetOwnerId: owner.ownerId,
      targetProcessInstanceId: owner.processInstanceId,
      targetPid: owner.pid,
    };
    const intentPath = lockPath + '.recovery.' + intentOwnerId;
    const partialCandidatePath = intentPath + '.candidate.' + intentOwnerId;
    await fs.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx' });
    await fs.writeFile(intentPath, JSON.stringify(intent), { flag: 'wx' });
    await fs.writeFile(lockPath + '.abandoned.' + owner.ownerId, JSON.stringify(owner), { flag: 'wx' });
    await fs.writeFile(lockPath + '.abandoned.' + intent.ownerId, JSON.stringify(intent), { flag: 'wx' });
    await fs.writeFile(partialCandidatePath, '{partial', { flag: 'wx' });

    await expect(withPersonaRuntimeLock(personaId, async (lock) => {
      await lock.assertOwned();
      return 'recovered';
    })).resolves.toBe('recovered');
    expect(sleep).not.toHaveBeenCalled();
    await expect(fs.access(intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(partialCandidatePath, 'utf8')).resolves.toBe('{partial');
  });

  it('waits conservatively when abandonment is published after the phase listing', async () => {
    await fs.mkdir(lockRoot, { recursive: true });
    const intent = {
      ...foreignOwner(intentOwnerId),
      targetOwnerId: foreignOwnerId,
      targetProcessInstanceId: 'predecessor-instance',
      targetPid: process.pid,
    };
    const intentPath = lockPath + '.recovery.' + intentOwnerId;
    const markerPath = lockPath + '.abandoned.' + intentOwnerId;
    await fs.writeFile(intentPath, JSON.stringify(intent), { flag: 'wx' });
    const originalReaddir = fs.readdir.bind(fs);
    jest.spyOn(fs, 'readdir').mockImplementationOnce(async (...args) => {
      const directoryNames = await originalReaddir(...args);
      await fs.writeFile(markerPath, JSON.stringify(intent), { flag: 'wx' });
      return directoryNames;
    });
    const protectedWork = jest.fn(async () => 'owned');
    sleep.mockImplementationOnce(async (ms) => {
      expect(protectedWork).not.toHaveBeenCalled();
      elapsed += ms;
    });

    await expect(withPersonaRuntimeLock(personaId, protectedWork)).resolves.toBe('owned');
    expect(sleep.mock.calls).toEqual([[25]]);
    expect(protectedWork).toHaveBeenCalledTimes(1);
    await expect(fs.access(intentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a named recovery intent contains malformed owner data', async () => {
    await fs.mkdir(lockRoot, { recursive: true });
    const intentPath = lockPath + '.recovery.' + intentOwnerId;
    await fs.writeFile(intentPath, JSON.stringify({ ownerId: '../unowned' }), { flag: 'wx' });
    const protectedWork = jest.fn();

    await expect(withPersonaRuntimeLock(personaId, protectedWork)).rejects.toThrow(/malformed/i);
    expect(protectedWork).not.toHaveBeenCalled();
    await expect(fs.readFile(intentPath, 'utf8')).resolves.toBe(JSON.stringify({ ownerId: '../unowned' }));
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['before-install', 'after-install'])(
    'propagates a %s listing failure and does not enter protected work',
    async (stage) => {
      const originalReaddir = fs.readdir.bind(fs);
      const scans = jest.spyOn(fs, 'readdir');
      const scanError = Object.assign(new Error('Cannot observe lock coordination.'), { code: 'EACCES' });
      if (stage === 'after-install') scans.mockImplementationOnce(originalReaddir);
      scans.mockRejectedValueOnce(scanError);
      const protectedWork = jest.fn();

      await expect(withPersonaRuntimeLock(personaId, protectedWork)).rejects.toBe(scanError);
      expect(protectedWork).not.toHaveBeenCalled();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(originalReaddir(lockRoot)).resolves.toEqual([]);
    },
  );
});
