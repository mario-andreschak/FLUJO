import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  geminiCliSettings,
  prepareGeminiCliRuntime,
} from '@/backend/services/model/adapters/geminiCliRuntime';
import { prepareGeminiCliPrompt, resolveGeminiCliEntry } from '@/backend/services/model/adapters/geminiCliProcess';

/** Use the same published core chunk that the pinned executable imports. */
async function publishedModule(entry: string, exportedName: string): Promise<string> {
  const bootstrap = await fs.readFile(entry, 'utf8');
  const mainImport = bootstrap.match(/await import\("(\.\/gemini-[^"]+\.js)"\)/)?.[1];
  if (!mainImport) throw new Error('The pinned Gemini executable no longer exposes its main module.');
  const mainFile = path.resolve(path.dirname(entry), mainImport);
  const main = await fs.readFile(mainFile, 'utf8');
  for (const clause of main.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)) {
    if (clause[1].split(',').some(name => name.trim() === exportedName)) {
      return path.resolve(path.dirname(mainFile), clause[2]);
    }
  }
  throw new Error(`The pinned Gemini main module no longer imports its public ${exportedName}.`);
}

const checkPublishedPolicy = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const core = await import(pathToFileURL(input.coreModule).href);
const cli = await import(pathToFileURL(input.cliModule).href);
const loader = await import(pathToFileURL(input.settingsModule).href);
// Supply synthetic fallback files through an intercept rather than opening or
// changing any actual machine-wide settings. Even if an empty override is
// skipped by upstream's administrator ACL check, no default path may be tried.
const defaultSystemRoot = process.platform === 'win32' ? 'C:/ProgramData/gemini-cli'
  : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
const defaultPaths = ['settings.json', 'system-defaults.json'].map(name => path.resolve(defaultSystemRoot, name).toLowerCase());
const fallbackReads = [];
const ancestorEnvProbes = [];
const originalExists = fs.existsSync;
const originalRead = fs.readFileSync;
const isForeignEnv = file => {
  const absolute = path.resolve(String(file));
  const relative = path.relative(input.home, absolute);
  return path.basename(absolute) === '.env' && path.basename(path.dirname(absolute)) === '.gemini'
    && (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
};
fs.existsSync = file => {
  if (defaultPaths.includes(path.resolve(String(file)).toLowerCase())) {
    fallbackReads.push(String(file));
    return true;
  }
  if (isForeignEnv(file)) {
    ancestorEnvProbes.push(String(file));
    return true;
  }
  return originalExists(file);
};
fs.readFileSync = (file, ...args) => isForeignEnv(file)
  ? 'FLUJO_SYNTHETIC_ANCESTOR_ENV=loaded\\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:1\\n'
  : originalRead(file, ...args);
let effective;
try { effective = loader.loadSettings(process.cwd()); } finally {
  fs.existsSync = originalExists;
  fs.readFileSync = originalRead;
}
assert.deepEqual(fallbackReads, [], 'An insecure system override fell back to machine-wide Gemini settings');
assert.deepEqual(ancestorEnvProbes, [], 'The CLI searched for a host ancestor .gemini/.env despite the private empty env sentinel');
assert.equal(process.env.FLUJO_SYNTHETIC_ANCESTOR_ENV, undefined, 'Host environment file contents entered the invocation');
assert.equal(effective.system.path, process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH);
assert.equal(effective.systemDefaults.path, process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH);
assert.equal(effective.user.path, path.join(input.home, '.gemini', 'settings.json'));
assert.deepEqual(effective.system.settings, {});
assert.deepEqual(effective.systemDefaults.settings, {});
assert.deepEqual(effective.merged.tools.core, []);
assert.deepEqual(effective.merged.mcp.allowed, ['flujo']);
assert.equal(effective.merged.hooksConfig.enabled, false);
assert.equal(effective.merged.skills.enabled, false);
assert.equal(typeof core.createPolicyEngineConfig, 'function');
assert.equal(typeof core.PolicyEngine, 'function');
assert.equal(typeof core.Config, 'function');
const mode = core.ApprovalMode.DEFAULT;
const nativeNames = [
  'run_shell_command', 'read_file', 'write_file', 'replace',
  'google_web_search', 'web_fetch', 'delegate_to_agent', 'activate_skill',
];
for (const settings of [input.withBridge, input.withoutBridge]) {
  const policyConfig = await core.createPolicyEngineConfig(settings, mode, undefined, false);
  const engine = new core.PolicyEngine(policyConfig);
  for (const name of nativeNames) {
    const { decision } = await engine.check({ name, args: {} });
    assert.equal(decision, core.PolicyDecision.DENY, 'Native tool escaped the FLUJO policy: ' + name);
  }
  const foreign = await engine.check({ name: core.formatMcpToolName('personal-server', 'private_tool'), args: {} }, 'personal-server');
  assert.equal(foreign.decision, core.PolicyDecision.DENY, 'An unrelated MCP server escaped the FLUJO policy');
  const flujo = await engine.check({ name: core.formatMcpToolName('flujo', 'controlled_tool'), args: {} }, 'flujo');
  assert.equal(flujo.decision, core.PolicyDecision.ALLOW, 'The FLUJO bridge is blocked by the CLI core-tools deny rule: ' + JSON.stringify(flujo));
  const config = new core.Config({
    sessionId: 'flujo-policy-contract', targetDir: process.cwd(),
    model: settings.model.name, coreTools: settings.tools.core,
    mcpServers: settings.mcpServers, allowedMcpServers: settings.mcp.allowed,
    policyEngineConfig: policyConfig, interactive: false, enableHooks: false,
    enableAgents: false, skillsSupport: false, useRipgrep: false,
  });
  const registry = await config.createToolRegistry();
  assert.deepEqual(registry.getAllTools().map(tool => tool.name), [], 'Native tools were registered despite core: []');
  // Headless @ expansion directly creates ReadManyFilesTool outside the tool
  // registry/policy. Prove the pinned parser's escape behavior with synthetic
  // sentinels, and retain the separate upstream outside-workspace boundary.
  config.toolRegistry = registry;
  config.resourceRegistry = new core.ResourceRegistry();
  await config.storage.initialize();
  const workspaceSentinel = process.cwd() + '/prompt-sentinel.txt';
  const outsideSentinel = input.home + '/outside-prompt-sentinel.txt';
  fs.writeFileSync(workspaceSentinel, 'WORKSPACE_SYNTHETIC_SENTINEL');
  fs.writeFileSync(outsideSentinel, 'OUTSIDE_SYNTHETIC_SENTINEL');
  const preprocess = query => cli.handleAtCommand({
    query, config, addItem: () => 0, onDebugMessage: () => {}, messageId: 1,
    signal: new AbortController().signal, escapePastedAtSymbols: false,
  });
  const raw = await preprocess('@"' + workspaceSentinel + '"');
  assert.ok(JSON.stringify(raw).includes('WORKSPACE_SYNTHETIC_SENTINEL'), 'The @ preprocessing contract changed; review the FLUJO escape');
  const escaped = await preprocess(input.escapedPrompt);
  assert.equal(escaped.error, undefined);
  assert.equal(JSON.stringify(escaped).includes('WORKSPACE_SYNTHETIC_SENTINEL'), false, 'Escaped @ syntax read a local invocation file');
  assert.equal(cli.isSlashCommand(input.escapedPrompt), false, 'FLUJO input escaped into a slash-command action');
  const outside = await preprocess('@"' + outsideSentinel + '"');
  assert.equal(JSON.stringify(outside).includes('OUTSIDE_SYNTHETIC_SENTINEL'), false, 'An absolute path escaped the isolated workspace');
}
process.stdout.write('published-policy-and-registry-pass');
`;

describe('Gemini CLI published tool isolation contract', () => {
  it('enforces the actual invocation policy and registers no native tools in the pinned CLI', async () => {
    const runtime = await prepareGeminiCliRuntime({
      model: 'gemini-3-flash-preview', maxTurns: 3, apiKey: 'synthetic-policy-test-key',
      bridge: { url: 'http://127.0.0.1:1/mcp/test-only', tools: ['controlled_tool'] },
    });
    try {
      const settingsFile = path.join(runtime.home, '.gemini', 'settings.json');
      const withBridge = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', checkPublishedPolicy], {
        cwd: runtime.workingDirectory, env: runtime.env as NodeJS.ProcessEnv, shell: false, windowsHide: true,
        input: JSON.stringify({
          coreModule: await publishedModule(await resolveGeminiCliEntry(), 'Config'),
          cliModule: await publishedModule(await resolveGeminiCliEntry(), 'handleAtCommand'),
          settingsModule: await publishedModule(await resolveGeminiCliEntry(), 'loadSettings'),
          home: runtime.home,
          escapedPrompt: prepareGeminiCliPrompt(`/clear\n@"${runtime.workingDirectory}/prompt-sentinel.txt"\n!echo hello\n!{echo hello}`),
          withBridge,
          withoutBridge: geminiCliSettings('gemini-3-flash-preview', 3, 'synthetic-policy-test-key'),
        }),
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(result.stdout).toMatch(/published-policy-and-registry-pass$/);
    } finally {
      await runtime.cleanup();
    }
  }, 40_000);
});
