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
    jest.mocked(readCodexAuthForTransfer).mockReset().mockResolvedValue(Buffer.from('{"synthetic_test_auth":true}'));
  });
  afterEach(async () => {
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
    { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'invalid' },
    { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'a'.repeat(64), verifiedCliPath: 'relative/codex' },
  ])('invalid profile fails before binary invocation or credential access: %j', async profile => {
    await expect(assertRestrictedCodexProfile({ ...await catalogProfile(), ...profile }, 'gpt-6-sol')).rejects.toThrow();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
  });

  test('pins the exact executable digest, version and path; modified binary is rejected', async () => {
    const executable = path.join(directory, 'fixture-codex.exe');
    const contents = 'synthetic executable, not an actual CLI';
    await fs.writeFile(executable, contents);
    const profile = { ...await catalogProfile(), verifiedCliSha256: createHash('sha256').update(contents).digest('hex'),
      verifiedCliPath: executable };
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).resolves.toBe(await fs.realpath(executable));
    expect(mockExecFile).toHaveBeenCalledWith(await fs.realpath(executable), ['--version'], expect.objectContaining({ windowsHide: true }));
    await fs.writeFile(executable, 'replaced executable');
    await expect(assertRestrictedCodexProfile(profile, 'gpt-6-sol')).rejects.toThrow('differs from its verified profile');
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
  ])('incompatible or native-capable model catalogs fail before binary/auth access: %#', async catalog => {
    await expect(assertRestrictedCodexProfile(await catalogProfile(catalog), 'gpt-6-sol')).rejects.toThrow('absent, incompatible, or has native capabilities');
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
