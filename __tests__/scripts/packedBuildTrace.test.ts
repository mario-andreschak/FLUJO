import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('npm omits build profiling output while retaining the production payload', () => {
  const repository = path.resolve(__dirname, '../..');
  const manifest = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
  const executableDirectory = path.dirname(process.execPath);
  // Qualification pins the complete npm closure before supplying this path.
  const configuredNpmCli = process.env.FLUJO_PACK_TEST_NPM_CLI;
  let resolvedNpmCli: string | undefined;
  if (configuredNpmCli !== undefined) {
    if (!path.isAbsolute(configuredNpmCli) || !existsSync(configuredNpmCli)
      || !statSync(configuredNpmCli).isFile()) {
      throw new Error('FLUJO_PACK_TEST_NPM_CLI must name an absolute existing file.');
    }
    resolvedNpmCli = realpathSync(configuredNpmCli);
  } else {
    resolvedNpmCli = [
      path.join(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
      path.resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    ].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  }
  if (!resolvedNpmCli) throw new Error('npm CLI was not found beside the test Node executable; use FLUJO_PACK_TEST_NPM_CLI for a pinned separate npm closure.');
  const npmCli = resolvedNpmCli;

  const temporaryDirectory = realpathSync(os.tmpdir());
  const fixtureRoot = mkdtempSync(path.join(temporaryDirectory, 'flujo-packed-build-trace-'));
  const retained = [
    'LICENSE',
    '.next/BUILD_ID',
    '.next/required-server-files.json',
    '.next/next-server.js.nft.json',
    '.next/server/app/api/health/route.js',
    '.next/server/app/api/health/route.js.nft.json',
    '.next/static/chunks/app.js',
    '.next/static/media/font.woff2',
    'public/avatar-audio-capture.js',
    'scripts/launch-next.mjs',
    'bin/flujo.mjs',
    'next.config.mjs',
    'mcp-servers/README.md',
    'mcp-servers/browser/scripts/install-browser.mjs',
  ];
  for (const workspace of manifest.workspaces) {
    if (workspace.startsWith('mcp-servers/')) {
      retained.push(`${workspace}/dist/index.js`, `${workspace}/LICENSE`, `${workspace}/package.json`);
    } else {
      const workspaceManifest = JSON.parse(readFileSync(path.join(repository, workspace, 'package.json'), 'utf8'));
      retained.push(`${workspace}/package.json`, ...workspaceManifest.files.map((file: string) => `${workspace}/${file}`));
    }
  }
  const omitted = ['.next/trace', '.next/cache/transient.bin', '.next/dev/server.js'];
  function packSelection(fixture: string, fixtureManifest: typeof manifest): string[] {
    mkdirSync(fixture, { recursive: true });
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(fixtureManifest));
    for (const file of [...retained, ...omitted]) {
      const target = path.join(fixture, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `synthetic packaging member: ${file}\n`);
    }
    // Workspace metadata is present, but no dependency installation is needed.
    for (const [index, workspace] of manifest.workspaces.entries()) {
      mkdirSync(path.join(fixture, workspace), { recursive: true });
      writeFileSync(path.join(fixture, workspace, 'package.json'), JSON.stringify({
        name: `pack-fixture-${index}`, version: manifest.version,
      }));
    }
    const userConfig = path.join(fixture, 'empty-user.npmrc');
    const globalConfig = path.join(fixture, 'empty-global.npmrc');
    writeFileSync(userConfig, '');
    writeFileSync(globalConfig, '');
    const environment: NodeJS.ProcessEnv = { ...process.env,
      npm_config_cache: path.join(fixture, 'npm-cache'),
      npm_config_userconfig: userConfig,
      npm_config_globalconfig: globalConfig,
      npm_config_update_notifier: 'false',
    };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_COMPILE_CACHE;
    const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts',
      '--json', '--workspaces=false', '--no-audit', '--no-fund'], {
      cwd: fixture, env: environment, windowsHide: true, encoding: 'utf8',
      timeout: 15000, maxBuffer: 1024 * 1024,
    });
    if (packed.error) throw packed.error;
    expect(packed.status).toBe(0);
    const reports = JSON.parse(packed.stdout);
    expect(reports).toHaveLength(1);
    return reports[0].files.map((file: { path: string }) => file.path.replaceAll('\\', '/'));
  }
  try {
    const files = packSelection(path.join(fixtureRoot, 'positive'), manifest);
    const negativeManifest = {
      ...manifest,
      files: manifest.files.filter((file: string) => file !== '!.next/trace'),
    };
    const negativeFiles = packSelection(path.join(fixtureRoot, 'negative'), negativeManifest);
    console.info('CODE_HEALTH_PACK_SELECTION', JSON.stringify({
      node: process.version, npmCli,
      npmCliSource: configuredNpmCli === undefined ? 'adjacent' : 'FLUJO_PACK_TEST_NPM_CLI',
      retained, omitted, selectedFiles: files, installedOrExecutedApp: false,
      negativeControl: {
        removedExclusion: '!.next/trace', selectedFiles: negativeFiles,
        traceIncluded: negativeFiles.includes('.next/trace'),
      },
    }));
    for (const file of retained) expect(files).toContain(file);
    for (const file of omitted) expect(files).not.toContain(file);
    for (const file of retained) expect(negativeFiles).toContain(file);
    expect(negativeFiles).toContain('.next/trace');
    for (const file of omitted.slice(1)) expect(negativeFiles).not.toContain(file);
  } finally {
    const resolved = realpathSync(fixtureRoot);
    if (path.dirname(resolved) !== temporaryDirectory
      || !path.basename(resolved).startsWith('flujo-packed-build-trace-')) {
      throw new Error('Refusing cleanup outside the allocated package fixture.');
    }
    rmSync(resolved, { recursive: true, force: true });
  }
}, 30000);
