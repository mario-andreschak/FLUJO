/** Filesystem/env/attestation unit gates; actual CLI capability probes are separate evidence. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { assertRestrictedCodexProfile, prepareRestrictedCodexRuntimeEnvironment } from '@/backend/services/model/adapters/codexRestrictedProfile';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';

let mockWorkspaceRoot: string;
const mockExecFile = jest.fn();
const mockReadStream = jest.fn();
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'),
  createReadStream: (...args: unknown[]) => mockReadStream(...args) }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockWorkspaceRoot }));
jest.mock('@/backend/services/model/adapters/codexAuth', () => ({ readCodexAuthForTransfer: jest.fn() }));
jest.mock('node:child_process', () => {
  const { promisify } = jest.requireActual('node:util');
  const execFile = jest.fn();
  Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => mockExecFile(...args) });
  return { ...jest.requireActual('node:child_process'), execFile };
});

describe('restricted Codex credential/runtime isolation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-boundary-'));
    mockWorkspaceRoot = directory;
    mockExecFile.mockReset().mockResolvedValue({ stdout: 'codex-cli 0.153.3\n', stderr: '' });
    mockReadStream.mockReset().mockImplementation(jest.requireActual('node:fs').createReadStream);
    jest.mocked(readCodexAuthForTransfer).mockReset().mockResolvedValue(Buffer.from('{"synthetic_test_auth":true}'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codex-boundary-')) {
      throw new Error('Unsafe test cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const selectedModel = { slug: 'gpt-6-sol', model_messages: { instructions_template: 'synthetic fixture' },
    apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, tool_mode: 'direct',
    use_responses_lite: false, supports_search_tool: false, multi_agent_version: null };
  async function catalogProfile(catalog: unknown = { client_version: '0.153.3', models: [selectedModel] }): Promise<RestrictedCodexProfile> {
    const verifiedModelCatalogPath = path.join(directory, 'verified-models.json');
    const bytes = JSON.stringify(catalog);
    await fs.writeFile(verifiedModelCatalogPath, bytes);
    return { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'a'.repeat(64),
      verifiedModelCatalogPath, verifiedModelCatalogSha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async function executableProfile(): Promise<RestrictedCodexProfile> {
    const verifiedCliPath = path.join(directory, 'fixture-codex.exe');
    const contents = 'synthetic executable, not an actual CLI';
    await fs.writeFile(verifiedCliPath, contents);
    return { ...await catalogProfile(), verifiedCliPath,
      verifiedCliSha256: createHash('sha256').update(contents).digest('hex') };
  }

  test('catalog descriptor drift fails before CLI verification or credential access', async () => {
    const profile = await executableProfile();
    const open = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (path.basename(String(args[0])) === path.basename(profile.verifiedModelCatalogPath)) {
        const stat = handle.stat.bind(handle);
        let reads = 0;
        jest.spyOn(handle, 'stat').mockImplementation(async (...statArgs: Parameters<typeof handle.stat>) => {
          const value = await stat(...statArgs);
          if (++reads === 2) value.ino = typeof value.ino === 'bigint' ? BigInt(0) : 0;
          return value;
        });
      }
      return handle;
    });
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).rejects.toThrow('model catalog is invalid');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockReadStream).not.toHaveBeenCalled();
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  // Keep --version pending until every concurrent caller has completed its own
  // two lstat reads. Tests exercise real streaming hashes and filesystem drift.
  function pendingVerification(callers: number, executable: string) {
    let release!: (value: { stdout: string; stderr: string }) => void;
    let ready!: () => void;
    let started!: () => void;
    const identitiesRead = new Promise<void>(resolve => { ready = resolve; });
    const invoked = new Promise<void>(resolve => { started = resolve; });
    const result = new Promise<{ stdout: string; stderr: string }>(resolve => { release = resolve; });
    let reads = 0;
    const lstat = fs.lstat.bind(fs);
    jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      if (args[0] === executable && ++reads === callers * 2) ready();
      return stat;
    });
    mockExecFile.mockImplementation(() => { started(); return result; });
    return { identitiesRead, invoked, release: () => release({ stdout: 'codex-cli 0.153.3\n', stderr: '' }) };
  }

  test('concurrent matching attestations share one hash/version check; each caller checks before and after', async () => {
    const profile = await executableProfile();
    const gate = pendingVerification(8, profile.verifiedCliPath!);
    const calls = Array.from({ length: 8 }, () => assertRestrictedCodexProfile(profile, 'gpt-6-sol'));
    await gate.identitiesRead;
    await gate.invoked;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockReadStream).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
    gate.release();
    await expect(Promise.all(calls)).resolves.toEqual(Array(8).fill(await fs.realpath(profile.verifiedCliPath!)));
    expect(jest.mocked(fs.lstat).mock.calls.filter(([file]) => file === profile.verifiedCliPath)).toHaveLength(32);
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).resolves.toBe(await fs.realpath(profile.verifiedCliPath!));
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  test('bad digests never launch the executable; rejected concurrent work is evicted and identical retries rehash', async () => {
    const profile = await executableProfile();
    const gate = pendingVerification(2, profile.verifiedCliPath!);
    let releaseHash!: () => void;
    const hashGate = new Promise<void>(resolve => { releaseHash = resolve; });
    const readStream = jest.requireActual('node:fs').createReadStream;
    mockReadStream.mockImplementation((...args: unknown[]) => (async function* () {
      await hashGate;
      yield* readStream(...args);
    })());
    const calls = Promise.allSettled([assertRestrictedCodexProfile({ ...profile, verifiedCliSha256: 'b'.repeat(64) }, 'gpt-6-sol'),
      assertRestrictedCodexProfile({ ...profile, verifiedCliSha256: 'b'.repeat(64) }, 'gpt-6-sol')]);
    await gate.identitiesRead;
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.release();
    releaseHash();
    expect((await calls).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(mockReadStream).toHaveBeenCalledTimes(1);
    expect(mockExecFile).not.toHaveBeenCalled();
    await expect(assertRestrictedCodexProfile({ ...profile, verifiedCliSha256: 'b'.repeat(64) }, 'gpt-6-sol'))
      .rejects.toThrow('differs from its verified profile');
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(mockExecFile).not.toHaveBeenCalled();
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).resolves.toBe(await fs.realpath(profile.verifiedCliPath!));
    expect(mockReadStream).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('concurrent distinct digest or version attestations cannot borrow another verification', async () => {
    const profile = await executableProfile();
    const gate = pendingVerification(3, profile.verifiedCliPath!);
    const calls = Promise.allSettled([assertRestrictedCodexProfile(profile, 'gpt-6-sol'),
      assertRestrictedCodexProfile({ ...profile, verifiedCliSha256: 'b'.repeat(64) }, 'gpt-6-sol'),
      assertRestrictedCodexProfile({ ...profile, verifiedCliVersion: '0.157.1' }, 'gpt-6-sol')]);
    await gate.identitiesRead;
    await new Promise<void>(resolve => setImmediate(resolve));
    gate.release();
    expect((await calls).map(result => result.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(mockReadStream).toHaveBeenCalledTimes(3);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  test('in-flight byte drift rejects every subscriber and a changed file starts a separate hash', async () => {
    const profile = await executableProfile();
    // A whole-ms fixture avoids Date conversion changing the original mtime.
    const fixedTime = new Date(1700000000000);
    await fs.utimes(profile.verifiedCliPath!, fixedTime, fixedTime);
    const gate = pendingVerification(2, profile.verifiedCliPath!);
    const first = Promise.allSettled([assertRestrictedCodexProfile(profile, 'gpt-6-sol'),
      assertRestrictedCodexProfile(profile, 'gpt-6-sol')]);
    await gate.identitiesRead;
    await gate.invoked;
    await new Promise<void>(resolve => setImmediate(resolve));
    // Preserve length and mtime: ctime is still part of the sharing identity.
    const original = await fs.stat(profile.verifiedCliPath!);
    await fs.writeFile(profile.verifiedCliPath!, 'x'.repeat(original.size));
    await fs.utimes(profile.verifiedCliPath!, original.atime, original.mtime);
    const rewritten = await fs.stat(profile.verifiedCliPath!);
    expect(rewritten.mtimeMs).toBe(original.mtimeMs);
    expect(rewritten.ctimeMs).not.toBe(original.ctimeMs);
    const changed = assertRestrictedCodexProfile(profile, 'gpt-6-sol');
    const changedResult = Promise.allSettled([changed]);
    gate.release();
    expect((await first).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect((await changedResult)[0].status).toBe('rejected');
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('an identical replacement at the same path gets fresh verification and rejects the old file identity', async () => {
    const profile = await executableProfile();
    const gate = pendingVerification(1, profile.verifiedCliPath!);
    const old = Promise.allSettled([assertRestrictedCodexProfile(profile, 'gpt-6-sol')]);
    await gate.invoked;
    const replacement = path.join(directory, 'replacement.exe');
    await fs.copyFile(profile.verifiedCliPath!, replacement);
    await fs.unlink(profile.verifiedCliPath!);
    await fs.rename(replacement, profile.verifiedCliPath!);
    const next = Promise.allSettled([assertRestrictedCodexProfile(profile, 'gpt-6-sol')]);
    gate.release();
    expect((await old)[0].status).toBe('rejected');
    expect((await next)[0].status).toBe('fulfilled');
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('different executable paths do not share verification even for matching bytes and expected versions', async () => {
    const profile = await executableProfile();
    const anotherPath = path.join(directory, 'another-codex.exe');
    await fs.copyFile(profile.verifiedCliPath!, anotherPath);
    await expect(Promise.all([assertRestrictedCodexProfile(profile, 'gpt-6-sol'),
      assertRestrictedCodexProfile({ ...profile, verifiedCliPath: anotherPath }, 'gpt-6-sol')]))
      .resolves.toEqual([await fs.realpath(profile.verifiedCliPath!), await fs.realpath(anotherPath)]);
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  test('every concurrent caller validates its own catalog and policy before joining verification', async () => {
    const profile = await executableProfile();
    const gate = pendingVerification(1, profile.verifiedCliPath!);
    const valid = assertRestrictedCodexProfile(profile, 'gpt-6-sol');
    await gate.identitiesRead;
    const unsafe = await catalogProfile({ client_version: '0.153.3', models: [{ ...selectedModel, tool_mode: 'auto' }] });
    await expect(assertRestrictedCodexProfile({ ...profile, ...unsafe }, 'gpt-6-sol')).rejects.toThrow('native capabilities');
    await expect(assertRestrictedCodexProfile(profile, 'unapproved-model')).rejects.toThrow('approved model');
    gate.release();
    await expect(valid).resolves.toBe(await fs.realpath(profile.verifiedCliPath!));
    expect(mockReadStream).toHaveBeenCalledTimes(1);
    await expect(prepareRestrictedCodexRuntimeEnvironment(profile)).rejects.toThrow('differs from its verified profile');
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('a retargeted parent symlink cannot reuse an in-flight canonical path verification', async () => {
    const profile = await executableProfile();
    const targetA = path.join(directory, 'target-a');
    const targetB = path.join(directory, 'target-b');
    const link = path.join(directory, 'current');
    await fs.mkdir(targetA);
    await fs.mkdir(targetB);
    await fs.copyFile(profile.verifiedCliPath!, path.join(targetA, 'codex.exe'));
    await fs.writeFile(path.join(targetB, 'codex.exe'), 'different binary');
    await fs.symlink(targetA, link, 'junction');
    const linked = { ...profile, verifiedCliPath: path.join(link, 'codex.exe') };
    let release!: (value: { stdout: string; stderr: string }) => void;
    let started!: () => void;
    const invoked = new Promise<void>(resolve => { started = resolve; });
    mockExecFile.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const old = Promise.allSettled([assertRestrictedCodexProfile(linked, 'gpt-6-sol')]);
    await invoked;
    await fs.unlink(link);
    await fs.symlink(targetB, link, 'junction');
    // The old invocation must fail its caller's fresh canonical resolution.
    mockExecFile.mockResolvedValue({ stdout: 'codex-cli 0.153.3\n', stderr: '' });
    const next = Promise.allSettled([assertRestrictedCodexProfile(linked, 'gpt-6-sol')]);
    release({ stdout: 'codex-cli 0.153.3\n', stderr: '' });
    expect((await old)[0].status).toBe('rejected');
    expect((await next)[0].status).toBe('rejected');
    expect(mockReadStream).toHaveBeenCalledTimes(2);
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('concurrent invocations receive distinct homes/cwds and exclude application/private environment', async () => {
    const runtimes = await Promise.all([prepareRestrictedCodexRuntimeEnvironment(), prepareRestrictedCodexRuntimeEnvironment()]);
    try {
      expect(runtimes[0].home).not.toBe(runtimes[1].home);
      expect(runtimes[0].workingDirectory).not.toBe(runtimes[1].workingDirectory);
      for (const runtime of runtimes) {
        expect(runtime.env.CODEX_HOME).toBe(runtime.home);
        expect(runtime.env.HOME).toBe(runtime.home);
        expect(runtime.env.USERPROFILE).toBe(runtime.home);
        expect(path.dirname(runtime.workingDirectory)).toBe(runtime.home);
        for (const field of ['FLUJO_EXECUTION_ADAPTER_MODULE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_CONFIG_OVERRIDES']) {
          expect(Object.keys(runtime.env)).not.toContain(field);
        }
        expect(runtime.configOverrides).toContain('project_root_markers=[]');
        expect(runtime.configOverrides.some(value => value.endsWith('.trust_level="untrusted"'))).toBe(true);
        expect(await fs.readdir(runtime.workingDirectory)).toEqual([]);
      }
      await runtimes[0].cleanup();
      await expect(fs.stat(runtimes[0].home)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(runtimes[1].home)).resolves.toBeDefined();
    } finally { await Promise.all(runtimes.map(runtime => runtime.cleanup())); }
  });

  test('credential transfer failure removes the partially created private home', async () => {
    jest.mocked(readCodexAuthForTransfer).mockRejectedValue(new Error('fixture transfer failure'));
    await expect(prepareRestrictedCodexRuntimeEnvironment()).rejects.toThrow('fixture transfer failure');
    expect(await fs.readdir(path.join(directory, 'db'))).toEqual([]);
  });

  test.each([
    { verifiedCliVersion: 'unverified', verifiedCliSha256: 'a'.repeat(64) },
    { verifiedCliVersion: '0.157.0', verifiedCliSha256: 'a'.repeat(64) },
    { verifiedCliVersion: '0.157.2', verifiedCliSha256: 'a'.repeat(64) },
    { verifiedCliVersion: '0.158.0', verifiedCliSha256: 'a'.repeat(64) },
    { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'invalid' },
    { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'a'.repeat(64), verifiedCliPath: 'relative/codex' },
  ])('invalid profile fails before binary invocation or credential access: %j', async profile => {
    await expect(assertRestrictedCodexProfile({ ...await catalogProfile(), ...profile }, 'gpt-6-sol')).rejects.toThrow();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test.each([
    ['0.153.3', 'gpt-6-sol'], ['0.153.3', 'gpt-6-luna'],
    ['0.157.1', 'gpt-6-sol'], ['0.157.1', 'gpt-6-luna'],
  ])('pins exact %s executable digest, version and path for %s independently of catalog source version', async (version, model) => {
    const executable = path.join(directory, 'fixture-codex.exe');
    const contents = 'synthetic executable, not an actual CLI';
    await fs.writeFile(executable, contents);
    const profile = { ...await catalogProfile({ client_version: '0.158.0', models: [{ ...selectedModel, slug: model }] }),
      verifiedCliVersion: version, verifiedCliSha256: createHash('sha256').update(contents).digest('hex'),
      verifiedCliPath: executable };
    mockExecFile.mockResolvedValue({ stdout: `codex-cli ${version}\n`, stderr: '' });
    await expect(assertRestrictedCodexProfile(profile, model)).resolves.toBe(await fs.realpath(executable));
    expect(mockExecFile).toHaveBeenCalledWith(await fs.realpath(executable), ['--version'], expect.objectContaining({ windowsHide: true }));
    mockExecFile.mockResolvedValue({ stdout: `codex-cli ${version === '0.153.3' ? '0.157.1' : '0.153.3'}\n`, stderr: '' });
    await expect(assertRestrictedCodexProfile(profile, model)).rejects.toThrow('differs from its verified profile');
    mockExecFile.mockResolvedValue({ stdout: `codex-cli ${version}\n`, stderr: '' });
    await fs.writeFile(executable, 'replaced executable');
    await expect(assertRestrictedCodexProfile(profile, model)).rejects.toThrow('differs from its verified profile');
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('another model or reported CLI version cannot borrow an otherwise matching digest', async () => {
    const executable = path.join(directory, 'fixture-codex.exe');
    await fs.writeFile(executable, 'fixture');
    const profile = { ...await catalogProfile(), verifiedCliSha256: createHash('sha256').update('fixture').digest('hex'),
      verifiedCliPath: executable };
    await expect(assertRestrictedCodexProfile(profile, 'unapproved-model')).rejects.toThrow();
    mockExecFile.mockResolvedValue({ stdout: 'codex-cli 0.153.4\n', stderr: '' });
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).rejects.toThrow('differs from its verified profile');
  });

  test.each([
    { client_version: 'unversioned', models: [selectedModel] },
    { client_version: '0.153.3', models: [] },
    { client_version: '0.153.3', models: [selectedModel, selectedModel] },
    { client_version: '0.153.3', models: [{ ...selectedModel, model_messages: undefined }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, apply_patch_tool_type: 'freeform' }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, experimental_supported_tools: ['shell'] }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, node_repl_disabled: false }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, tool_mode: 'auto' }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, use_responses_lite: true }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, supports_search_tool: true }] },
    { client_version: '0.153.3', models: [{ ...selectedModel, multi_agent_version: 'v2' }] },
  ])('incompatible or native-capable model catalogs fail before binary/auth access for both admitted versions: %#', async catalog => {
    const profile = await catalogProfile(catalog);
    for (const version of ['0.153.3', '0.157.1']) {
      await expect(assertRestrictedCodexProfile({ ...profile, verifiedCliVersion: version }, 'gpt-6-sol'))
        .rejects.toThrow('absent, incompatible, or has native capabilities');
    }
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('missing catalog and catalog digest drift fail before credentials or runtime directories', async () => {
    const profile = await catalogProfile();
    await fs.unlink(profile.verifiedModelCatalogPath);
    await expect(prepareRestrictedCodexRuntimeEnvironment(profile)).rejects.toThrow();
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).rejects.toThrow();
    await fs.writeFile(profile.verifiedModelCatalogPath, '{}');
    await expect(prepareRestrictedCodexRuntimeEnvironment(profile)).rejects.toThrow('differs from its verified profile');
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual(['verified-models.json']);
  });

  test('each runtime receives its own verified catalog snapshot, unaffected by later source edits', async () => {
    const profile = await catalogProfile();
    const original = await fs.readFile(profile.verifiedModelCatalogPath, 'utf8');
    const runtimes = await Promise.all([prepareRestrictedCodexRuntimeEnvironment(profile), prepareRestrictedCodexRuntimeEnvironment(profile)]);
    try {
      expect(runtimes[0].modelCatalogPath).not.toBe(runtimes[1].modelCatalogPath);
      await fs.writeFile(profile.verifiedModelCatalogPath, '{"changed":true}');
      for (const runtime of runtimes) {
        expect(path.dirname(runtime.modelCatalogPath!)).toBe(runtime.home);
        expect(await fs.readFile(runtime.modelCatalogPath!, 'utf8')).toBe(original);
      }
      await expect(prepareRestrictedCodexRuntimeEnvironment(profile)).rejects.toThrow('differs from its verified profile');
      expect(readCodexAuthForTransfer).toHaveBeenCalledTimes(2);
    } finally { await Promise.all(runtimes.map(runtime => runtime.cleanup())); }
  });
});
