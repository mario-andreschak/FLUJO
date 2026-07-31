#!/usr/bin/env node
/** Validate the synchronized standalone MCP release set and packed artifacts. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootPackage = readJson(path.join(root, 'package.json'));
const rootLock = readJson(path.join(root, 'package-lock.json'));
const packages = [
  { directory: 'bash', name: '@mario.andreschak/mcp-bash', bin: 'flujo-mcp-bash' },
  { directory: 'browser', name: '@mario.andreschak/mcp-browser', bin: 'flujo-mcp-browser' },
  { directory: 'filesystem', name: '@mario.andreschak/mcp-filesystem', bin: 'flujo-mcp-filesystem' },
  { directory: 'flujo', name: '@mario.andreschak/mcp-flujo', bin: 'flujo-mcp-flujo' },
];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function fail(message) {
  throw new Error(`MCP release validation failed: ${message}`);
}

if (rootLock.version !== rootPackage.version || rootLock.packages?.['']?.version !== rootPackage.version) {
  fail(`package-lock root version does not match flujo-ai ${rootPackage.version}`);
}

function packedFiles(target) {
  const output = execFileSync(
    npmCommand,
    ['pack', '--dry-run', '--json', '--ignore-scripts', target],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const result = JSON.parse(output);
  if (!Array.isArray(result) || !result[0]?.files) {
    fail(`npm pack returned no file inventory for ${target}`);
  }
  return new Set(result[0].files.map(({ path: file }) => file.replaceAll('\\', '/')));
}

for (const entry of packages) {
  const packageDirectory = path.join(root, 'mcp-servers', entry.directory);
  const packageJson = readJson(path.join(packageDirectory, 'package.json'));
  const binTarget = packageJson.bin?.[entry.bin];

  if (packageJson.name !== entry.name) fail(`${entry.directory} has package name ${packageJson.name}`);
  if (packageJson.version !== rootPackage.version) {
    fail(`${entry.name} is ${packageJson.version}; flujo-ai is ${rootPackage.version}`);
  }
  if (rootPackage.dependencies?.[entry.name] !== rootPackage.version) {
    fail(`flujo-ai must depend on ${entry.name}@${rootPackage.version} exactly`);
  }
  if (rootLock.packages?.['']?.dependencies?.[entry.name] !== rootPackage.version) {
    fail(`package-lock root pin for ${entry.name} is not ${rootPackage.version}`);
  }
  if (rootLock.packages?.[`mcp-servers/${entry.directory}`]?.version !== rootPackage.version) {
    fail(`package-lock workspace version for ${entry.name} is not ${rootPackage.version}`);
  }
  if (binTarget !== 'dist/index.js' || !existsSync(path.join(packageDirectory, binTarget))) {
    fail(`${entry.name} is missing its built ${entry.bin} binary`);
  }
  if (
    entry.directory === 'browser'
    && packageJson.scripts?.install !== 'patchright install chromium'
  ) {
    fail(`${entry.name} must automatically install its managed Chromium binary`);
  }

  const childFiles = packedFiles(`./mcp-servers/${entry.directory}`);
  if (!childFiles.has('dist/index.js') || !childFiles.has('package.json')) {
    fail(`${entry.name} tarball omits its binary or manifest`);
  }
}

const rootFiles = packedFiles('.');
for (const required of [
  'package.json',
  'bin/flujo.mjs',
  'scripts/launch-next.mjs',
  '.next/BUILD_ID',
  '.next/routes-manifest.json',
  '.next/server/app-paths-manifest.json',
]) {
  if (!rootFiles.has(required)) fail(`flujo-ai tarball omits ${required}`);
}
for (const entry of packages) {
  for (const required of [
    `mcp-servers/${entry.directory}/dist/index.js`,
    `mcp-servers/${entry.directory}/package.json`,
  ]) {
    if (!rootFiles.has(required)) fail(`flujo-ai tarball omits ${required}`);
  }
}

console.log(`Validated flujo-ai and four standalone MCP packages at ${rootPackage.version}.`);
