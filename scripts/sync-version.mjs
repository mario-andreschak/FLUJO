// Propagates the package.json version into the source files and README badge
// that hard-code it. Runs automatically as npm's "version" lifecycle script,
// so `npm version patch|minor|<x.y.z>` keeps every occurrence in sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPackagePath = path.join(root, 'package.json');
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));
const { version } = rootPackage;

const publicMcpPackages = [
  { directory: 'bash', name: '@mario.andreschak/mcp-bash' },
  { directory: 'browser', name: '@mario.andreschak/mcp-browser' },
  { directory: 'filesystem', name: '@mario.andreschak/mcp-filesystem' },
  { directory: 'flujo', name: '@mario.andreschak/mcp-flujo' },
];

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The public MCP packages are released atomically with flujo-ai. Keep both
// their manifests and the root's exact production dependency pins synchronized.
for (const { directory, name } of publicMcpPackages) {
  const packagePath = path.join(root, 'mcp-servers', directory, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.version = version;
  writeJson(packagePath, packageJson);
  rootPackage.dependencies[name] = version;
  console.log(`sync-version: ${name} -> ${version}`);
}
writeJson(rootPackagePath, rootPackage);

const lockPath = path.join(root, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = version;
lock.packages[''].version = version;
for (const { directory, name } of publicMcpPackages) {
  lock.packages[''].dependencies[name] = version;
  lock.packages[`mcp-servers/${directory}`].version = version;
}
writeJson(lockPath, lock);

const targets = [
  {
    file: 'src/backend/services/mcp/connection.ts',
    pattern: /(version: ')\d+\.\d+\.\d+(')/,
  },
  {
    file: 'src/app/mcp-proxy/[server]/route.ts',
    pattern: /(const PROXY_VERSION = ')\d+\.\d+\.\d+(')/,
  },
  {
    file: 'src/app/mcp-flows/route.ts',
    pattern: /(const SERVER_VERSION = ')\d+\.\d+\.\d+(')/,
  },
  {
    file: 'README.md',
    pattern: /(badge\/version-)\d+\.\d+\.\d+(-green)/,
  },
  {
    file: 'githubpages/index.html',
    pattern: /(<span id="app-version">v)\d+\.\d+\.\d+(<\/span>)/,
  },
];

let failed = false;
for (const { file, pattern } of targets) {
  const abs = path.join(root, file);
  const content = readFileSync(abs, 'utf8');
  if (!pattern.test(content)) {
    console.error(`sync-version: version pattern not found in ${file}`);
    failed = true;
    continue;
  }
  writeFileSync(abs, content.replace(pattern, `$1${version}$2`));
  console.log(`sync-version: ${file} -> ${version}`);
}
if (failed) process.exit(1);
