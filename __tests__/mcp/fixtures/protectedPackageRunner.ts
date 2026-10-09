import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource,
  TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES } from '@/backend/services/security/trustedHostMcp';

/** Materialize genuine installed npm and an offline synthetic package; no installer runs. */
export function materializeProtectedPackageRunner(serverName: string, sourceCode: string): MCPStdioConfig {
  const sourceRoot = path.join(getWorkspaceDataDir(), 'mcp-servers', 'reviewed-runner-' + createHash('sha256').update(serverName).digest('hex').slice(0, 12));
  const npmSource = process.env.npm_execpath ? path.dirname(path.dirname(process.env.npm_execpath))
    : process.platform === 'win32' ? path.join(process.env.ProgramFiles!, 'nodejs', 'node_modules', 'npm')
      : path.dirname(require.resolve('npm/package.json'));
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.cpSync(npmSource, path.join(sourceRoot, 'npm'), { recursive: true, dereference: true });
  const packageDirectory = path.join(sourceRoot, 'project');
  const packageRoot = path.join(packageDirectory, 'node_modules', 'owned-probe');
  const bins = path.join(packageDirectory, 'node_modules', '.bin');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(bins, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: 'reviewed-project',
    version: '1.0.0', private: true, dependencies: { 'owned-probe': '1.0.0' } }));
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'owned-probe',
    version: '1.0.0', bin: { 'owned-probe': 'server.cjs' } }));
  fs.writeFileSync(path.join(packageRoot, 'server.cjs'), sourceCode, { mode: 0o700 });
  // Source-bound regular files, rather than links or an unreviewed shim generator.
  fs.writeFileSync(path.join(bins, 'owned-probe'), `#!/bin/sh\nbasedir=\${0%/*}\nexec "${process.execPath}" "$basedir/../owned-probe/server.cjs" "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bins, 'owned-probe.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0\\..\\owned-probe\\server.cjs" %*\r\n`);
  const shell = path.join(sourceRoot, process.platform === 'win32' ? 'cmd.exe' : 'sh');
  fs.copyFileSync(process.platform === 'win32' ? process.env.ComSpec! : fs.realpathSync('/bin/sh'), shell);
  fs.chmodSync(shell, 0o700);
  for (const name of ['runner-user.npmrc', 'runner-global.npmrc']) fs.writeFileSync(path.join(sourceRoot, name), '');
  const runtimeHome = path.join(getWorkspaceDataDir(), 'userdata', 'mcp-runtime',
    createHash('sha256').update(serverName).digest('hex').slice(0, 24), 'home');
  const cwdDirectory = path.join(path.dirname(runtimeHome), 'cwd');
  fs.mkdirSync(cwdDirectory, { recursive: true });
  const cwd = cwdDirectory;
  const env = { NPM_CONFIG_CACHE: path.join(runtimeHome, '.npm'),
    PATH: [bins, path.dirname(process.execPath)].join(path.delimiter),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot!, ComSpec: shell, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}) };
  const entryPoint = path.join(sourceRoot, 'npm', 'bin', 'npx-cli.js');
  const config: MCPStdioConfig = { name: serverName, transport: 'stdio', command: process.execPath,
    args: ['-y', 'owned-probe@1.0.0', '--synthetic-argument'], cwd, env,
    disabled: false, runtimeHomeMode: 'isolated', roots: [], rootPath: '', _buildCommand: '', _installCommand: '',
    trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'npx',
      runtimeHome: 'isolated', entryPoint, sourceRoot, sourceDigest: fingerprintTrustedHostSource(sourceRoot),
      executableDigest: fingerprintTrustedHostExecutable(process.execPath),
      packageRunner: { packageName: 'owned-probe', packageVersion: '1.0.0',
        npmVersion: JSON.parse(fs.readFileSync(path.join(npmSource, 'package.json'), 'utf8')).version, packageDirectory,
        binaryName: 'owned-probe', shell, shellDigest: fingerprintTrustedHostExecutable(shell) },
      environmentNames: [...new Set([...Object.keys(env), ...TRUSTED_HOST_RUNTIME_HOME_ENVIRONMENT_NAMES])] } };
  return config;
}
