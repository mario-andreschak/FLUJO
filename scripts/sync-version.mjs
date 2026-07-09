// Propagates the package.json version into the source files and README badge
// that hard-code it. Runs automatically as npm's "version" lifecycle script,
// so `npm version patch|minor|<x.y.z>` keeps every occurrence in sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

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
