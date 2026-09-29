import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readCodexAuthForTransfer } from './codexAuth';

/** Evidence supplied by the trusted integration after exercising this exact binary. */
export interface RestrictedCodexProfile {
  verifiedCliVersion: string;
  verifiedCliSha256: string;
  /** Optional dedicated tested binary; ordinary SDK installations stay unchanged. */
  verifiedCliPath?: string;
  verifiedModelCatalogPath: string;
  verifiedModelCatalogSha256: string;
}

// A version string alone is insufficient: admission also pins the native binary
// digest after the integration's inventory and forced-tool denial probes pass.
const SUPPORTED_VERSIONS = new Set(['0.153.3', '0.157.1']);
const SUPPORTED_MODELS = new Set(['gpt-6-sol', 'gpt-6-luna']);

/** Optional policy for private tool-only runs; ordinary Codex settings are unchanged. */
export const RESTRICTED_CODEX_CONFIG = Object.freeze({
  forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file',
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  history: Object.freeze({ persistence: 'none' }),
  tools: Object.freeze({ view_image: false }),
  features: Object.freeze({
    shell_tool: false,
    unified_exec: false,
    multi_agent: false,
    multi_agent_v2: false,
    apps: false,
    plugins: false,
    browser_use: false,
    browser_use_external: false,
    computer_use: false,
    code_mode: false,
    code_mode_host: false,
    image_generation: false,
    memories: false,
    hooks: false,
    skill_search: false,
    tool_suggest: false,
    workspace_dependencies: false,
    goals: false,
    in_app_browser: false,
    sleep_tool: false,
    // CLI 0.153.3 still advertises view_image with only tools.view_image=false.
    view_image: false,
    auth_elicitation: false,
    tool_call_mcp_elicitation: false,
    default_mode_request_user_input: false,
  }),
});

export const RESTRICTED_CODEX_THREAD_OPTIONS = Object.freeze({
  sandboxMode: 'read-only',
  webSearchMode: 'disabled',
  networkAccessEnabled: false,
  approvalPolicy: 'never',
} as const);

function baseEnvironment(): Record<string, string> {
  // Do not pass application configuration, MCP credentials, assertions, API
  // keys, customer mappings, or personal Codex overrides to the subprocess.
  const names = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'TZ', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  return Object.fromEntries(names.flatMap(name => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

/** Match the SDK's native-package resolver, then invoke only the checked path. */
function bundledExecutable(): string {
  const triples: Record<string, string> = {
    'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
    'darwin:x64': 'x86_64-apple-darwin', 'darwin:arm64': 'aarch64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc', 'win32:arm64': 'aarch64-pc-windows-msvc',
  };
  const triple = triples[`${process.platform}:${process.arch}`];
  if (!triple) throw new Error('Restricted Codex profile does not support this platform.');
  const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
  const codexRequire = createRequire(localRequire.resolve('@openai/codex/package.json'));
  const platformPackage = `@openai/codex-${process.platform}-${process.arch}`;
  const root = path.dirname(codexRequire.resolve(`${platformPackage}/package.json`));
  return path.join(root, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
}

async function readVerifiedModelCatalog(profile: RestrictedCodexProfile): Promise<Buffer> {
  if (!path.isAbsolute(profile.verifiedModelCatalogPath ?? '')
    || !/^[a-f0-9]{64}$/.test(profile.verifiedModelCatalogSha256 ?? '')) {
    throw new Error('Restricted Codex requires a verified model catalog.');
  }
  const before = await fs.lstat(profile.verifiedModelCatalogPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024 * 1024) {
    throw new Error('Restricted Codex model catalog is invalid.');
  }
  const bytes = await fs.readFile(profile.verifiedModelCatalogPath);
  const after = await fs.lstat(profile.verifiedModelCatalogPath);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== before.size
    || createHash('sha256').update(bytes).digest('hex') !== profile.verifiedModelCatalogSha256) {
    throw new Error('Restricted Codex model catalog differs from its verified profile.');
  }
  return bytes;
}

function assertCatalogModel(bytes: Buffer, model: string): void {
  try {
    const catalog = JSON.parse(bytes.toString('utf8'));
    // Preserve the public catalog's source version; compatibility is exercised
    // against the separately pinned CLI and exact restricted catalog bytes.
    if (typeof catalog.client_version !== 'string'
      || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/.test(catalog.client_version)
      || !Array.isArray(catalog.models)) throw new Error();
    const matches = catalog.models.filter((entry: { slug?: unknown }) => entry?.slug === model);
    if (matches.length !== 1) throw new Error();
    const selected = matches[0];
    if (!selected.model_messages || typeof selected.model_messages !== 'object'
      || Array.isArray(selected.model_messages)
      // Disabling shell does not disable a catalog-enabled native apply_patch handler.
      || selected.apply_patch_tool_type !== null
      || !Array.isArray(selected.experimental_supported_tools) || selected.experimental_supported_tools.length !== 0
      || selected.node_repl_disabled !== true || selected.tool_mode !== 'direct'
      // Lite requests hide tool definitions; v2 collaboration metadata can
      // activate subagents independently of the corresponding feature flags.
      || selected.use_responses_lite !== false || selected.supports_search_tool !== false
      || selected.multi_agent_version !== null) throw new Error();
  } catch {
    throw new Error('Restricted Codex selected model is absent, incompatible, or has native capabilities.');
  }
}

// Share only work that is still running. Each caller independently checks its
// file identity before joining and after verification, and validates its catalog.
const executableVerifications = new Map<string, Promise<void>>();

function fileIdentity(stat: Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]);
}

async function executableIdentity(requestedPath: string) {
  const requested = await fs.lstat(requestedPath);
  const executable = await fs.realpath(requestedPath);
  const resolved = await fs.lstat(executable);
  if ((!requested.isFile() && !requested.isSymbolicLink())
    || !resolved.isFile() || resolved.isSymbolicLink()) {
    throw new Error('Restricted Codex binary differs from its verified profile.');
  }
  return { executable, identity: JSON.stringify([fileIdentity(requested), fileIdentity(resolved)]) };
}

function verifyExecutable(executable: string, digest: string, version: string): Promise<void> {
  return (async () => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(executable)) hash.update(chunk);
    const { stdout } = await promisify(execFile)(executable, ['--version'], {
      env: { ...baseEnvironment(), NODE_ENV: 'production' }, encoding: 'utf8',
      timeout: 10000, maxBuffer: 4096, windowsHide: true,
    });
    if (stdout.trim() !== `codex-cli ${version}` || hash.digest('hex') !== digest) {
      throw new Error('Restricted Codex binary differs from its verified profile.');
    }
  })();
}

/** Reject drift before creating a credential-bearing runtime or sending model input. */
export async function assertRestrictedCodexProfile(
  profile: RestrictedCodexProfile,
  model: string,
): Promise<string> {
  if (!profile || !SUPPORTED_VERSIONS.has(profile.verifiedCliVersion)
    || !/^[a-f0-9]{64}$/.test(profile.verifiedCliSha256) || !SUPPORTED_MODELS.has(model)) {
    throw new Error('Restricted Codex requires a verified CLI profile and an approved model.');
  }
  assertCatalogModel(await readVerifiedModelCatalog(profile), model);
  if (profile.verifiedCliPath !== undefined && !path.isAbsolute(profile.verifiedCliPath)) {
    throw new Error('Restricted Codex binary path must be absolute.');
  }
  const requestedPath = profile.verifiedCliPath ?? bundledExecutable();
  const before = await executableIdentity(requestedPath);
  const key = JSON.stringify([requestedPath, before.executable, profile.verifiedCliSha256,
    profile.verifiedCliVersion, before.identity]);
  let verification = executableVerifications.get(key);
  if (!verification) {
    // Evict on both outcomes without leaving a detached rejecting promise.
    verification = verifyExecutable(before.executable, profile.verifiedCliSha256, profile.verifiedCliVersion)
      .then(() => { executableVerifications.delete(key); }, error => {
        executableVerifications.delete(key);
        throw error;
      });
    executableVerifications.set(key, verification);
  }
  try {
    await verification;
  } finally {
    const after = await executableIdentity(requestedPath);
    if (before.executable !== after.executable || before.identity !== after.identity) {
      throw new Error('Restricted Codex binary differs from its verified profile.');
    }
  }
  return before.executable;
}

export interface RestrictedCodexRuntimeEnvironment {
  home: string;
  workingDirectory: string;
  env: Record<string, string>;
  configOverrides: string[];
  modelCatalogPath?: string;
  cleanup: () => Promise<void>;
}

/** A fresh subscription-authenticated home for one invocation; never resume another run. */
export async function prepareRestrictedCodexRuntimeEnvironment(
  profile?: RestrictedCodexProfile,
): Promise<RestrictedCodexRuntimeEnvironment> {
  // Snapshot verified public metadata before reading credentials. The child
  // receives this immutable per-invocation file, preventing remote refresh drift.
  const catalog = profile ? await readVerifiedModelCatalog(profile) : undefined;
  const parent = path.resolve(getWorkspaceDataDir(), 'db');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const home = await fs.mkdtemp(path.join(parent, 'codex-private-'));
  const cleanup = async () => {
    const target = path.resolve(home);
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('codex-private-')) {
      throw new Error('Restricted Codex cleanup target is outside its runtime directory.');
    }
    await fs.rm(target, { recursive: true, force: true });
  };
  try {
    const workingDirectory = path.join(home, 'workspace');
    const paths = { APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_RUNTIME_DIR: path.join(home, '.runtime'),
      TMPDIR: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp') };
    await Promise.all([workingDirectory, ...new Set(Object.values(paths))]
      .map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    const modelCatalogPath = catalog ? path.join(home, 'model-catalog.json') : undefined;
    if (modelCatalogPath) await fs.writeFile(modelCatalogPath, catalog!, { flag: 'wx', mode: 0o600 });
    const auth = await readCodexAuthForTransfer();
    await fs.writeFile(path.join(home, 'auth.json'), auth, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n',
      { flag: 'wx', mode: 0o600 });
    const env = { ...baseEnvironment(), ...paths, HOME: home, USERPROFILE: home, CODEX_HOME: home };
    if (process.platform === 'win32') {
      const root = path.parse(home).root;
      Object.assign(env, { HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1) });
    }
    // A neutral cwd nested beneath a repository must not acquire its project
    // MCPs, skills, rules or hooks. Raw TOML keeps path keys intact in the SDK.
    const configOverrides = ['project_root_markers=[]',
      `projects.${JSON.stringify(workingDirectory)}.trust_level="untrusted"`];
    return { home, workingDirectory, env, configOverrides, modelCatalogPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
