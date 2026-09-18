import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createWorkspace, getWorkspaceDir, renameWorkspace, runWithWorkspace } from '@/utils/workspace';
import { createShippedServerConfig, SHIPPED_MCP_SERVERS } from '@/backend/services/mcp/shippedServers';
import { ensureShippedWorkspacePackages, shippedWorkspacePackageRuntimeDigest } from '@/backend/services/mcp/shippedWorkspacePackages';
import { attachShippedWorkspaceReadiness, resolveStdioLaunch } from '@/backend/services/mcp/connection';

const execute = promisify(execFile);

describe('workspace copies of shipped application packages', () => {
  let fixture: string;
  let application: string;
  let previousApp: string | undefined;
  let previousData: string | undefined;
  const write = async (relative: string, value: string) => {
    const file = path.join(application, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  };
  const copied = (workspace: string, file: string) => path.join(getWorkspaceDir(workspace), 'mcp-servers', file);

  beforeEach(async () => {
    previousApp = process.env.FLUJO_APP_ROOT;
    previousData = process.env.FLUJO_DATA_DIR;
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-template-test-'));
    application = path.join(fixture, 'application');
    process.env.FLUJO_APP_ROOT = application;
    process.env.FLUJO_DATA_DIR = path.join(fixture, 'external-data');
    await write('node_modules/fixture-dependency/package.json', JSON.stringify({
      name: 'fixture-dependency', type: 'module', exports: './index.js',
    }));
    await write('node_modules/fixture-dependency/index.js', 'export const value = "external dependency works";');
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      const prefix = `mcp-servers/${descriptor.packageDirectory}`;
      await write(`${prefix}/package.json`, JSON.stringify({ name: descriptor.packageId, type: 'module', dependencies: { 'fixture-dependency': '1.0.0' } }));
      await write(`${prefix}/src/index.ts`, 'original source');
      await write(`${prefix}/dist/index.js`, 'export { value } from "fixture-dependency";');
      await write(`${prefix}/userdata/keep-private.txt`, 'runtime data');
    }
    await write('mcp-servers/shared/package.json', '{"name":"@flujo-ai/mcp-shared","type":"module"}');
    await write('mcp-servers/shared/src/index.ts', 'shared source');
    await write('mcp-servers/embed-shared.mjs', '// build helper');
  });

  afterEach(async () => {
    if (previousApp === undefined) delete process.env.FLUJO_APP_ROOT;
    else process.env.FLUJO_APP_ROOT = previousApp;
    if (previousData === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousData;
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it('creates independent package sources for each workspace without moving templates or runtime data', async () => {
    await createWorkspace('alpha');
    await createWorkspace('beta');
    await fs.writeFile(copied('alpha', 'bash/src/index.ts'), 'workspace edit');

    await expect(fs.readFile(path.join(application, 'mcp-servers/bash/src/index.ts'), 'utf8')).resolves.toBe('original source');
    await expect(fs.readFile(copied('beta', 'bash/src/index.ts'), 'utf8')).resolves.toBe('original source');
    await expect(fs.readFile(copied('alpha', 'bash/src/index.ts'), 'utf8')).resolves.toBe('workspace edit');
    await expect(fs.stat(copied('alpha', 'bash/userdata'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(copied('alpha', 'shared/src/index.ts'), 'utf8')).resolves.toBe('shared source');
    await expect(fs.readFile(copied('alpha', 'embed-shared.mjs'), 'utf8')).resolves.toBe('// build helper');
    expect(await fs.realpath(copied('alpha', 'bash/node_modules'))).toBe(await fs.realpath(path.join(application, 'node_modules')));
  });

  it('resolves ESM dependencies for a copy outside the application tree without an install', async () => {
    await createWorkspace('external');
    const entry = pathToFileURL(copied('external', 'filesystem/dist/index.js')).href;
    const result = await execute(process.execPath, ['--input-type=module', '-e',
      `const loaded = await import(${JSON.stringify(entry)}); process.stdout.write(loaded.value);`],
    { cwd: getWorkspaceDir('external'), timeout: 5_000 });
    expect(result.stdout).toBe('external dependency works');
  });

  it.each([false, true])('resolves npm-hoisted dependencies with nested overrides: %s', async mixed => {
    const hoistedRoot = path.join(fixture, 'node_modules');
    await fs.rename(path.join(application, 'node_modules'), hoistedRoot);
    const installedApplication = path.join(hoistedRoot, 'flujo-ai');
    await fs.rename(application, installedApplication);
    application = installedApplication;
    process.env.FLUJO_APP_ROOT = application;
    if (mixed) {
      await write('node_modules/nested-dependency/package.json', '{"name":"nested-dependency","type":"module","exports":"./index.js"}');
      await write('node_modules/nested-dependency/index.js', 'export const nested = "nested works";');
      await write('mcp-servers/filesystem/package.json', JSON.stringify({
        name: SHIPPED_MCP_SERVERS[1].packageId, type: 'module',
        dependencies: { 'fixture-dependency': '1.0.0', 'nested-dependency': '1.0.0' },
      }));
      await write('mcp-servers/filesystem/dist/index.js', 'import { value } from "fixture-dependency"; import { nested } from "nested-dependency"; export const result = value + ";" + nested;');
    }
    await createWorkspace('hoisted');
    const entry = pathToFileURL(copied('hoisted', 'filesystem/dist/index.js')).href;
    const result = await execute(process.execPath, ['--input-type=module', '-e',
      `const loaded = await import(${JSON.stringify(entry)}); process.stdout.write(loaded.result ?? loaded.value);`],
    { cwd: getWorkspaceDir('hoisted'), timeout: 5_000 });
    expect(result.stdout).toBe(mixed ? 'external dependency works;nested works' : 'external dependency works');
  });

  it('executes dependency resolution after Next webpack production compilation without newer Node builtin APIs', async () => {
    // Compile the actual helper, substituting only the descriptor module so this
    // exercises production transformation without loading application services.
    const result = await execute(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const require = createRequire(path.join(process.cwd(), 'package.json'));
      const ts = require('typescript');
      const { webpack } = require('next/dist/compiled/webpack/webpack');
      const fixture = ${JSON.stringify(fixture)};
      const source = await fs.readFile(path.join(process.cwd(), 'src/backend/services/mcp/shippedWorkspacePackages.ts'), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
      } }).outputText;
      await fs.writeFile(path.join(fixture, 'helper.mjs'), compiled);
      await fs.writeFile(path.join(fixture, 'shippedServers.mjs'),
        'export const SHIPPED_MCP_SERVERS = ' + ${JSON.stringify(JSON.stringify(SHIPPED_MCP_SERVERS))} + '; export function shippedMcpAppRoot(){ return process.env.FLUJO_APP_ROOT; }');
      const compiler = webpack({ mode: 'production', target: 'node', optimization: { minimize: false },
        entry: path.join(fixture, 'helper.mjs'), resolve: { extensions: ['.mjs', '.js'], fullySpecified: false },
        module: { rules: [{ test: /\\.mjs$/, type: 'javascript/auto', parser: { createRequire: true }, resolve: { fullySpecified: false } }] },
        output: { path: path.join(fixture, 'bundle'), filename: 'helper.cjs', library: { type: 'commonjs2' } },
      });
      const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => error ? reject(error) : resolve(stats)));
      await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
      const info = stats.toJson({ all: false, errors: true, warnings: true });
      const evidence = { warnings: info.warnings.map(item => item.message), errors: info.errors.map(item => item.message), values: [] };
      try {
        const helper = require(path.join(fixture, 'bundle/helper.cjs'));
        // Node 22.0 meets the app's engine constraint but lacks getBuiltinModule.
        // Prove that compiled execution does not depend on that later addition.
        process.getBuiltinModule = undefined;
        const workspace = path.join(fixture, 'compiled-workspace');
        await fs.mkdir(workspace);
        await helper.ensureShippedWorkspacePackages(workspace, ${JSON.stringify(application)}, ['filesystem']);
        const loaded = await import(pathToFileURL(path.join(workspace, 'mcp-servers/filesystem/dist/index.js')).href);
        evidence.values.push(loaded.value);
      } catch (error) { evidence.runtimeError = String(error); }
      process.stdout.write(JSON.stringify(evidence));
    `], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 1024 * 1024 });
    const evidence = JSON.parse(result.stdout);
    expect(evidence.runtimeError).toBeUndefined();
    expect(evidence.errors).toEqual([]);
    expect(evidence.warnings).toEqual([]);
    expect(evidence.values).toEqual(['external dependency works']);
  }, 35_000);

  it('preserves existing edits across repeated startup and application updates; future copies use the new template', async () => {
    await createWorkspace('edited');
    await fs.writeFile(copied('edited', 'bash/src/index.ts'), 'my edit');
    await write('mcp-servers/bash/src/index.ts', 'new application version');
    await ensureShippedWorkspacePackages(getWorkspaceDir('edited'));
    await ensureShippedWorkspacePackages(getWorkspaceDir('edited'));
    await createWorkspace('new-version');

    await expect(fs.readFile(copied('edited', 'bash/src/index.ts'), 'utf8')).resolves.toBe('my edit');
    await expect(fs.readFile(copied('new-version', 'bash/src/index.ts'), 'utf8')).resolves.toBe('new application version');
  });

  it('clones distributed artifacts when a packaged application has no source tree or shared build helper', async () => {
    for (const descriptor of SHIPPED_MCP_SERVERS) {
      await fs.rm(path.join(application, 'mcp-servers', descriptor.packageDirectory, 'src'), { recursive: true });
    }
    await fs.rm(path.join(application, 'mcp-servers/shared'), { recursive: true });
    await fs.rm(path.join(application, 'mcp-servers/embed-shared.mjs'));
    await createWorkspace('packaged');
    await expect(fs.readFile(copied('packaged', 'bash/dist/index.js'), 'utf8')).resolves.toContain('fixture-dependency');
    await expect(fs.stat(copied('packaged', 'bash/src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a linked source tree and rolls back only the newly-created workspace', async () => {
    const source = path.join(application, 'mcp-servers/bash/src');
    await fs.rm(source, { recursive: true });
    await fs.symlink(path.join(application, 'mcp-servers/filesystem/src'), source,
      process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createWorkspace('unsafe')).rejects.toThrow('must not contain links');
    await expect(fs.stat(getWorkspaceDir('unsafe'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(path.join(application, 'mcp-servers/filesystem/src/index.ts'), 'utf8')).resolves.toBe('original source');
  });

  it('refuses to replace an existing workspace package junction', async () => {
    await createWorkspace('original');
    const target = getWorkspaceDir('collision');
    await fs.mkdir(path.join(target, 'mcp-servers'), { recursive: true });
    await fs.symlink(copied('original', 'bash'), path.join(target, 'mcp-servers/bash'),
      process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ensureShippedWorkspacePackages(target)).rejects.toThrow('must not be a symlink or junction');
    await expect(fs.readFile(copied('original', 'bash/src/index.ts'), 'utf8')).resolves.toBe('original source');
  });

  it('keeps launch and data paths in the renamed workspace without rewriting package code', async () => {
    await createWorkspace('before-rename');
    const config = runWithWorkspace('before-rename', () => createShippedServerConfig(SHIPPED_MCP_SERVERS[1]));
    await renameWorkspace('before-rename', 'after-rename');
    const launch = runWithWorkspace('after-rename', () => resolveStdioLaunch(config));
    expect(launch.cwd).toBe(copied('after-rename', 'filesystem'));
    expect(launch.env.FLUJO_DATA_DIR).toBe(getWorkspaceDir('after-rename'));
    await expect(fs.stat(path.resolve(launch.cwd, launch.args[0]))).resolves.toBeDefined();
  });

  it('accepts an application-root alias but does not copy its runtime data', async () => {
    const alias = path.join(fixture, 'app-alias');
    await fs.symlink(application, alias, process.platform === 'win32' ? 'junction' : 'dir');
    process.env.FLUJO_APP_ROOT = alias;
    await createWorkspace('aliased');
    await expect(fs.readFile(copied('aliased', 'bash/src/index.ts'), 'utf8')).resolves.toBe('original source');
  });

  it('repairs missing dependencies without overwriting edits and rejects an unrelated package', async () => {
    await createWorkspace('existing');
    await fs.rm(copied('existing', 'bash/node_modules'), { recursive: true });
    await fs.writeFile(copied('existing', 'bash/src/index.ts'), 'preserved');
    await ensureShippedWorkspacePackages(getWorkspaceDir('existing'), application, ['bash']);
    expect(await fs.realpath(copied('existing', 'bash/node_modules'))).toBe(await fs.realpath(path.join(application, 'node_modules')));
    await expect(fs.readFile(copied('existing', 'bash/src/index.ts'), 'utf8')).resolves.toBe('preserved');
    await fs.writeFile(copied('existing', 'bash/package.json'), '{"name":"user-owned"}');
    await expect(ensureShippedWorkspacePackages(getWorkspaceDir('existing'), application, ['bash'])).rejects.toThrow('different package');
    await expect(fs.readFile(copied('existing', 'bash/package.json'), 'utf8')).resolves.toBe('{"name":"user-owned"}');
  });

  it('rejects an unbuilt template and a partial existing copy rather than publishing either as ready', async () => {
    await fs.rm(path.join(application, 'mcp-servers/bash/dist/index.js'));
    await expect(createWorkspace('unbuilt')).rejects.toThrow('not built');
    await write('mcp-servers/bash/dist/index.js', 'export {};');
    await createWorkspace('partial');
    await fs.rm(copied('partial', 'bash/dist/index.js'));
    await expect(ensureShippedWorkspacePackages(getWorkspaceDir('partial'), application, ['bash'])).rejects.toThrow('not built');
    await expect(fs.stat(copied('partial', 'bash/dist/index.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records provenance and refuses a snapshot recipe after source code changes', async () => {
    await createWorkspace('snapshot');
    const root = copied('snapshot', 'bash');
    await expect(shippedWorkspacePackageRuntimeDigest(root)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await fs.writeFile(path.join(root, 'src/index.ts'), 'local customization');
    await expect(shippedWorkspacePackageRuntimeDigest(root)).rejects.toThrow('local changes');
  });

  it('retries interrupted mixed dependency repair without changing package code or publishing partial links', async () => {
    await write('mcp-servers/filesystem/node_modules/nested-dependency/package.json', '{"name":"nested-dependency"}');
    await write('mcp-servers/filesystem/package.json', JSON.stringify({
      name: SHIPPED_MCP_SERVERS[1].packageId, type: 'module',
      dependencies: { 'fixture-dependency': '1.0.0', 'nested-dependency': '1.0.0' },
    }));
    await createWorkspace('repair');
    const dependencies = copied('repair', 'filesystem/node_modules');
    await fs.rm(dependencies, { recursive: true });
    await fs.writeFile(copied('repair', 'filesystem/src/index.ts'), 'preserved edit');
    const originalSymlink = fs.symlink.bind(fs);
    const spy = jest.spyOn(fs, 'symlink');
    spy.mockImplementationOnce(originalSymlink).mockRejectedValueOnce(Object.assign(new Error('interrupted link'), { code: 'EIO' }));
    try {
      await expect(ensureShippedWorkspacePackages(getWorkspaceDir('repair'), application, ['filesystem'])).rejects.toThrow('interrupted link');
    } finally { spy.mockRestore(); }
    await expect(fs.stat(dependencies)).rejects.toMatchObject({ code: 'ENOENT' });
    await ensureShippedWorkspacePackages(getWorkspaceDir('repair'), application, ['filesystem']);
    expect(await fs.realpath(path.join(dependencies, 'fixture-dependency'))).toBe(await fs.realpath(path.join(application, 'node_modules/fixture-dependency')));
    expect(await fs.realpath(path.join(dependencies, 'nested-dependency'))).toBe(await fs.realpath(path.join(application, 'mcp-servers/filesystem/node_modules/nested-dependency')));
    await expect(fs.readFile(copied('repair', 'filesystem/src/index.ts'), 'utf8')).resolves.toBe('preserved edit');
  });

  it('materializes an enabled package before transport start and leaves custom roots alone', async () => {
    const workspace = getWorkspaceDir('lazy');
    await fs.mkdir(workspace, { recursive: true });
    const config = runWithWorkspace('lazy', () => createShippedServerConfig(SHIPPED_MCP_SERVERS[2]));
    const start = jest.fn(async () => {
      await expect(fs.stat(path.join(workspace, 'mcp-servers/bash/dist/index.js'))).resolves.toBeDefined();
    });
    const transport = { start };
    runWithWorkspace('lazy', () => attachShippedWorkspaceReadiness(transport, config, path.join(workspace, config.rootPath)));
    await transport.start();
    expect(start).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(workspace, 'mcp-servers/browser'))).rejects.toMatchObject({ code: 'ENOENT' });
    const custom = { start: jest.fn(async () => {}) };
    const customStart = custom.start;
    runWithWorkspace('lazy', () => attachShippedWorkspaceReadiness(custom, { ...config, rootPath: 'custom' }, path.join(workspace, 'custom')));
    expect(custom.start).toBe(customStart);
  });
});
