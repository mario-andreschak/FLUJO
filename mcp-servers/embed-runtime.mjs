import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = process.argv[2];
if (!['bash', 'browser', 'filesystem', 'flujo'].includes(server)) {
  throw new Error('Usage: node embed-runtime.mjs <bash|browser|filesystem|flujo>');
}
const servers = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(servers, server, 'dist');
const sourceImport = "import '../../../bin/node-runtime-preflight.mjs';";
const entries = [];
for (const file of ['index.js', 'index.d.ts']) {
  const entryPath = path.join(dist, file);
  const entry = await readFile(entryPath, 'utf8');
  if (entry.split(sourceImport).length !== 2) throw new Error('MCP entry and declaration must contain exactly one runtime preflight import.');
  entries.push([entryPath, entry.replace(sourceImport, "import './node-runtime-preflight.mjs';")]);
}
for (const file of ['node-runtime.mjs', 'node-runtime-preflight.mjs', 'node-runtime-preflight.d.mts']) {
  await copyFile(path.join(servers, '..', 'bin', file), path.join(dist, file));
}
for (const [entryPath, entry] of entries) await writeFile(entryPath, entry);
