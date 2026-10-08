import { promises as fs } from 'fs';

import {
  _getPersonaRuntimeLockProcessBirthMarkerForTests,
  _queryWindowsProcessBirthMarkerForTests,
  _setPersonaRuntimeLockProcessBirthProbeForTests,
  _setPersonaRuntimeLockProcessBirthProbeRunnerForTests,
  initializePersonaRuntimeLockProcessIdentity,
  withPersonaRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import {
  _setPersonaRuntimeClockForTests,
  type PersonaRuntimeClock,
} from '@/backend/services/enduringAgents/runtimeClock';

jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: jest.fn(),
  runInWriteChain: (_key: string, task: () => Promise<unknown>) => task(),
}));
jest.mock('@/utils/workspace', () => ({
  ensureWorkspaceDirs: jest.fn(async () => undefined),
  getCurrentWorkspace: () => 'own-identity-test',
  getWorkspaceDbDir: () => '/own-identity-test/db',
}));

const marker = 'win32-v2:638927322190000000';
let savedIdentity: Promise<string | null> | undefined;
let savedClock: PersonaRuntimeClock | undefined;
let savedSystemRoot: string | undefined;
let elapsed: number;
let sleep: jest.Mock<Promise<void>, [number]>;

beforeEach(() => {
  savedIdentity = global.__flujo_enduring_agent_process_birth_marker_v2;
  global.__flujo_enduring_agent_process_birth_marker_v2 = undefined;
  savedSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  elapsed = 0;
  sleep = jest.fn(async (ms: number) => { elapsed += ms; });
  savedClock = _setPersonaRuntimeClockForTests({
    now: () => elapsed,
    monotonicNow: () => elapsed,
    sleep,
    setTimer: () => { throw new Error('Unexpected timer in own-identity initialization.'); },
  });
});

afterEach(() => {
  global.__flujo_enduring_agent_process_birth_marker_v2 = savedIdentity;
  _setPersonaRuntimeLockProcessBirthProbeForTests();
  _setPersonaRuntimeLockProcessBirthProbeRunnerForTests();
  _setPersonaRuntimeClockForTests(savedClock);
  if (savedSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = savedSystemRoot;
  jest.restoreAllMocks();
});

describe('Persona runtime own-process birth identity', () => {
  it('shares the complete transient-failure retry sequence and caches its successful identity', async () => {
    const probe = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { killed: true }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(marker);
    _setPersonaRuntimeLockProcessBirthProbeForTests(probe);

    await expect(Promise.all([
      initializePersonaRuntimeLockProcessIdentity(),
      initializePersonaRuntimeLockProcessIdentity(),
      _getPersonaRuntimeLockProcessBirthMarkerForTests(process.pid),
    ])).resolves.toEqual([undefined, undefined, marker]);
    expect(probe.mock.calls).toEqual([[process.pid], [process.pid], [process.pid]]);
    expect(sleep.mock.calls).toEqual([[100], [100]]);

    await expect(initializePersonaRuntimeLockProcessIdentity()).resolves.toBeUndefined();
    await expect(_getPersonaRuntimeLockProcessBirthMarkerForTests(process.pid)).resolves.toBe(marker);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('shares in-flight initialization with a separately evaluated route bundle', async () => {
    let settleFirst!: (value: string | null) => void;
    const probe = jest.fn()
      .mockImplementationOnce(() => new Promise<string | null>((resolve) => { settleFirst = resolve; }))
      .mockResolvedValueOnce(marker);
    _setPersonaRuntimeLockProcessBirthProbeForTests(probe);
    const first = initializePersonaRuntimeLockProcessIdentity();
    let sibling!: Promise<void>;
    await jest.isolateModulesAsync(async () => {
      const bundle = await import('@/backend/services/enduringAgents/runtimeLock');
      const siblingProbe = jest.fn().mockRejectedValue(new Error('Sibling must join the existing sequence.'));
      bundle._setPersonaRuntimeLockProcessBirthProbeForTests(siblingProbe);
      sibling = bundle.initializePersonaRuntimeLockProcessIdentity();
      settleFirst(null);
      await expect(Promise.all([first, sibling])).resolves.toEqual([undefined, undefined]);
      expect(siblingProbe).not.toHaveBeenCalled();
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('exhausts a shared bounded sequence, then allows a new initialization attempt', async () => {
    const probe = jest.fn(async () => {
      elapsed += 3_000;
      throw Object.assign(new Error('command and environment details must stay private'), { killed: true });
    });
    _setPersonaRuntimeLockProcessBirthProbeForTests(probe);
    const outcomes = await Promise.allSettled([
      initializePersonaRuntimeLockProcessIdentity(),
      initializePersonaRuntimeLockProcessIdentity(),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: new Error('Unable to establish this process birth identity for Persona locking. '
          + 'Failed after 3 attempts: process birth probe timed out.'),
      });
    }
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [100]]);
    expect(elapsed).toBe(9_200);
    expect(global.__flujo_enduring_agent_process_birth_marker_v2).toBeUndefined();

    const recoveredProbe = jest.fn().mockResolvedValue(marker);
    _setPersonaRuntimeLockProcessBirthProbeForTests(recoveredProbe);
    await expect(initializePersonaRuntimeLockProcessIdentity()).resolves.toBeUndefined();
    expect(recoveredProbe).toHaveBeenCalledTimes(1);
    expect(global.__flujo_enduring_agent_process_birth_marker_v2).toBeDefined();
  });

  it('does not create a lock candidate or execute protected work without its own identity', async () => {
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    jest.spyOn(fs, 'realpath').mockImplementation(async (input) => String(input));
    const write = jest.spyOn(fs, 'writeFile');
    const link = jest.spyOn(fs, 'link');
    const protectedWork = jest.fn();
    _setPersonaRuntimeLockProcessBirthProbeForTests(async () => null);

    await expect(withPersonaRuntimeLock('persona_identity_unavailable', protectedWork))
      .rejects.toThrow('probe returned no valid birth identity');
    expect(write).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
    expect(protectedWork).not.toHaveBeenCalled();
  });

  it.each([null, 'win32-v2:not-ticks'])(
    'fails closed on an invalid identity cached by an older bundle, then recovers: %j',
    async (cachedMarker) => {
      jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
      jest.spyOn(fs, 'realpath').mockImplementation(async (input) => String(input));
      const write = jest.spyOn(fs, 'writeFile');
      const link = jest.spyOn(fs, 'link');
      const protectedWork = jest.fn();
      const probe = jest.fn().mockResolvedValue(marker);
      _setPersonaRuntimeLockProcessBirthProbeForTests(probe);
      global.__flujo_enduring_agent_process_birth_marker_v2 = Promise.resolve(cachedMarker);

      await expect(withPersonaRuntimeLock('persona_legacy_identity', protectedWork))
        .rejects.toThrow('Shared process birth identity is missing or invalid.');
      expect(probe).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(link).not.toHaveBeenCalled();
      expect(protectedWork).not.toHaveBeenCalled();
      expect(global.__flujo_enduring_agent_process_birth_marker_v2).toBeUndefined();

      await expect(initializePersonaRuntimeLockProcessIdentity()).resolves.toBeUndefined();
      await expect(_getPersonaRuntimeLockProcessBirthMarkerForTests(process.pid)).resolves.toBe(marker);
      expect(probe).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['dead:linux-zombie', 'win32-v2:not-ticks', 'unversioned-marker'])(
    'does not cache an invalid own-process observation: %s',
    async (invalidMarker) => {
      const probe = jest.fn().mockResolvedValue(invalidMarker);
      _setPersonaRuntimeLockProcessBirthProbeForTests(probe);
      await expect(initializePersonaRuntimeLockProcessIdentity())
        .rejects.toThrow('probe returned an invalid birth identity');
      expect(probe).toHaveBeenCalledTimes(3);
      expect(global.__flujo_enduring_agent_process_birth_marker_v2).toBeUndefined();
    },
  );

  it('reports a concise spawn-failure category without exposing subprocess details', async () => {
    _setPersonaRuntimeLockProcessBirthProbeForTests(async () => {
      throw Object.assign(new Error('private command text'), { code: 'ENOENT' });
    });
    await expect(initializePersonaRuntimeLockProcessIdentity()).rejects.toThrow(
      'Failed after 3 attempts: process birth probe failed (ENOENT).',
    );
  });

  it('allows 3 seconds for its own Windows probe while keeping foreign probes at 900 ms', async () => {
    const runner = jest.fn().mockResolvedValue({ stdout: '638927322190000000\r\n' });
    _setPersonaRuntimeLockProcessBirthProbeRunnerForTests(runner);
    await expect(_queryWindowsProcessBirthMarkerForTests(process.pid)).resolves.toBe(marker);
    await expect(_queryWindowsProcessBirthMarkerForTests(process.pid + 1)).resolves.toBe(marker);
    expect(runner.mock.calls[0][2]).toMatchObject({ timeout: 3_000, windowsHide: true });
    expect(runner.mock.calls[1][2]).toMatchObject({ timeout: 900, windowsHide: true });
  });

  it.each(['', '0', '-123', '1.5', '123\n456', 'warning: process lookup\n123'])(
    'rejects unexpected Windows probe output: %j',
    async (stdout) => {
      _setPersonaRuntimeLockProcessBirthProbeRunnerForTests(jest.fn().mockResolvedValue({ stdout }));
      await expect(_queryWindowsProcessBirthMarkerForTests(process.pid)).resolves.toBeNull();
    },
  );
});
