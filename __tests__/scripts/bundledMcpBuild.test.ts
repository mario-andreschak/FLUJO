import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundledMcpEntry } from '../helpers/bundledMcpEntry';

type BuildResult = { ok: boolean; detail?: string };
type EnsureOptions = {
  log?: (line: string) => void;
  build?: (root: string) => Promise<BuildResult>;
  lockWaitMs?: number;
  lockPollMs?: number;
};

const {
  ensureBundledMcpBuilt,
  formatUnbuiltMcpMessage,
  npmInvocation,
  unbuiltMcpPackages,
} = require('../../scripts/bundled-mcp-build.cjs') as {
  ensureBundledMcpBuilt(root: string, options?: EnsureOptions): Promise<{ built: boolean; missing: string[] }>;
  formatUnbuiltMcpMessage(names: string[], root: string): string;
  npmInvocation(options: { execPath: string; platform: NodeJS.Platform; env: Record<string, string | undefined> }): {
    file: string;
    args: string[];
    shell: boolean;
  };
  unbuiltMcpPackages(root: string): string[];
};

const repository = path.resolve(__dirname, '../..');

function write(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function buildEntry(root: string, name: string): void {
  write(path.join(root, 'mcp-servers', name, 'dist', 'index.js'), 'export {};');
}

describe('bundled MCP package build', () => {
  let root: string;
  let lines: string[];
  const log = (line: string) => { lines.push(line); };
  const lockFile = () => path.join(root, 'node_modules', '.cache', 'flujo-build-mcp.lock');

  function sourceCheckout(names: string[], buildScript = 'node build.js'): void {
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'checkout', private: true, scripts: { 'build:mcp': buildScript } }));
    write(path.join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}');
    for (const name of names) {
      write(path.join(root, 'mcp-servers', name, 'package.json'), JSON.stringify({ name }));
      write(path.join(root, 'mcp-servers', name, 'src', 'index.ts'), 'export {};');
    }
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-bundled-mcp-build-'));
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists only bundled packages that still have no dist/index.js', () => {
    const servers = path.join(root, 'mcp-servers');
    for (const name of ['shared', 'flujo', 'bash']) write(path.join(servers, name, 'package.json'), JSON.stringify({ name }));
    buildEntry(root, 'shared');
    fs.mkdirSync(path.join(servers, 'notes'), { recursive: true });

    expect(unbuiltMcpPackages(root)).toEqual(['bash', 'flujo']);
    expect(unbuiltMcpPackages(path.join(root, 'missing'))).toEqual([]);
  });

  it('names the missing packages and the exact command', () => {
    const message = formatUnbuiltMcpMessage(['bash', 'flujo'], root);
    expect(message).toContain('bash, flujo');
    expect(message).toContain('`npm run build:mcp`');
    expect(message).toContain(root);
  });

  it('builds a source checkout that was never built, once', async () => {
    sourceCheckout(['shared', 'bash']);
    const build = jest.fn(async (target: string) => {
      buildEntry(target, 'shared');
      buildEntry(target, 'bash');
      return { ok: true };
    });

    await expect(ensureBundledMcpBuilt(root, { log, build })).resolves.toEqual({ built: true, missing: [] });
    await expect(ensureBundledMcpBuilt(root, { log, build })).resolves.toEqual({ built: false, missing: [] });
    expect(build).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('Building the bundled MCP packages (bash, shared)');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('does not build without sources or TypeScript, and says what to run instead', async () => {
    sourceCheckout(['bash']);
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    const build = jest.fn(async () => ({ ok: true }));

    await expect(ensureBundledMcpBuilt(root, { log, build })).resolves.toEqual({ built: false, missing: ['bash'] });
    expect(build).not.toHaveBeenCalled();
    expect(lines).toEqual([formatUnbuiltMcpMessage(['bash'], root)]);
  });

  it('carries on after a failed build and names the fix', async () => {
    sourceCheckout(['flujo']);

    const result = await ensureBundledMcpBuilt(root, { log, build: async () => ({ ok: false, detail: 'exited with 2' }) });

    expect(result).toEqual({ built: false, missing: ['flujo'] });
    expect(lines.at(-1)).toContain('failed (exited with 2)');
    expect(lines.at(-1)).toContain('`npm run build:mcp`');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('lets parallel callers share one build', async () => {
    sourceCheckout(['bash']);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const build = jest.fn(async (target: string) => {
      await gate;
      buildEntry(target, 'bash');
      return { ok: true };
    });

    const first = ensureBundledMcpBuilt(root, { log, build, lockPollMs: 10 });
    const second = ensureBundledMcpBuilt(root, { log, build, lockPollMs: 10 });
    while (build.mock.calls.length === 0) await new Promise((resolve) => { setTimeout(resolve, 5); });
    release();

    const results = await Promise.all([first, second]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.missing)).toEqual([[], []]);
  });

  it('removes a lock left behind by a build that is gone', async () => {
    sourceCheckout(['bash']);
    const finished = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    write(lockFile(), JSON.stringify({ pid: finished.pid, startedAt: Date.now() }));
    const build = jest.fn(async (target: string) => { buildEntry(target, 'bash'); return { ok: true }; });

    await expect(ensureBundledMcpBuilt(root, { log, build, lockWaitMs: 1_000 })).resolves.toEqual({ built: true, missing: [] });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('removes an unreadable lock and a lock older than any build', async () => {
    sourceCheckout(['bash', 'flujo']);
    write(lockFile(), 'not json');
    const build = jest.fn(async (target: string) => { buildEntry(target, 'bash'); return { ok: true }; });
    await ensureBundledMcpBuilt(root, { log, build, lockWaitMs: 1_000 });
    expect(build).toHaveBeenCalledTimes(1);

    write(lockFile(), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 60 * 60_000 }));
    build.mockImplementation(async (target: string) => { buildEntry(target, 'flujo'); return { ok: true }; });
    await expect(ensureBundledMcpBuilt(root, { log, build, lockWaitMs: 1_000 })).resolves.toEqual({ built: true, missing: [] });
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('waits a bounded time for a live build, then names the fix instead of hanging', async () => {
    sourceCheckout(['bash']);
    write(lockFile(), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const build = jest.fn(async () => ({ ok: true }));

    const result = await ensureBundledMcpBuilt(root, { log, build, lockWaitMs: 50, lockPollMs: 10 });

    expect(result).toEqual({ built: false, missing: ['bash'] });
    expect(build).not.toHaveBeenCalled();
    expect(lines.at(-1)).toContain('Another MCP package build is still running.');
    expect(fs.readFileSync(lockFile(), 'utf8')).toContain(String(process.pid));
  });

  it('runs the real build:mcp script through npm', async () => {
    sourceCheckout(['bash'], 'node build.js');
    write(path.join(root, 'build.js'), [
      "const fs = require('node:fs');",
      "fs.mkdirSync('mcp-servers/bash/dist', { recursive: true });",
      "fs.writeFileSync('mcp-servers/bash/dist/index.js', 'export {};');",
    ].join('\n'));

    await expect(ensureBundledMcpBuilt(root, { log })).resolves.toEqual({ built: true, missing: [] });
    expect(bundledMcpEntry('bash', root)).toBe(path.join(root, 'mcp-servers', 'bash', 'dist', 'index.js'));
  }, 120_000);

  it('runs npm through the npm CLI that came with this Node.js', () => {
    const cli = path.join(root, 'npm-cli.js');
    write(cli);
    expect(npmInvocation({ execPath: process.execPath, platform: process.platform, env: { npm_execpath: cli } }))
      .toEqual({ file: process.execPath, args: [cli], shell: false });
    expect(npmInvocation({ execPath: path.join(root, 'node'), platform: 'linux', env: {} }))
      .toEqual({ file: 'npm', args: [], shell: false });
  });

  it('names the package and the command when a test starts an unbuilt bundled server', () => {
    expect(() => bundledMcpEntry('bash', root)).toThrow(formatUnbuiltMcpMessage(['bash'], root));
  });

  it('is wired into Jest setup and the development start', () => {
    const jestConfig = fs.readFileSync(path.join(repository, 'jest.config.mjs'), 'utf8');
    expect(jestConfig).toContain('globalSetup: "<rootDir>/jest.globalSetup.cjs"');
    expect(fs.readFileSync(path.join(repository, 'jest.globalSetup.cjs'), 'utf8')).toContain('ensureBundledMcpBuilt(globalConfig.rootDir)');
    const launcher = fs.readFileSync(path.join(repository, 'scripts', 'launch-next.mjs'), 'utf8');
    const devStart = launcher.indexOf("if (passthroughArgs[0] === 'dev') {");
    expect(devStart).toBeGreaterThan(-1);
    expect(launcher.slice(devStart, devStart + 400)).toContain('await ensureBundledMcpBuilt(');
  });
});
