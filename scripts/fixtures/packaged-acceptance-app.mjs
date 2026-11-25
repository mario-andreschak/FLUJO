// A tiny stand-in for an installed FLUJO, used by packaged-acceptance.test.mjs
// to exercise real start, stop, crash and restart handling without a build.
// FIXTURE_MODE selects one deliberate fault:
//   memory-only-changes  keeps writes sent with ?stage=change in memory only
//   accept-damaged       answers 200 to a damaged backup
//   ignore-old-data      starts empty when the data was written by another version
//   ignore-stop          ignores SIGTERM
//   exit-early           prints a message and exits before listening
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(argument('--port'));
const dataDir = argument('--data');
const helperPidFile = process.argv.includes('--helper-pid-file') ? argument('--helper-pid-file') : undefined;
const mode = process.env.FIXTURE_MODE ?? '';
const version = process.env.FIXTURE_VERSION ?? '1';
const file = path.join(dataDir, 'records.json');

if (mode === 'exit-early') {
  console.error('fixture refused to start: boom');
  process.exit(3);
}

let records = {};
try {
  const stored = JSON.parse(await readFile(file, 'utf8'));
  records = mode === 'ignore-old-data' && stored.writtenBy !== version ? {} : stored;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function persist() {
  await writeFile(`${file}.tmp`, JSON.stringify(records));
  await rename(`${file}.tmp`, file);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/cwd') return send(response, 200, { cwd: process.cwd(), mcpServersDir: path.join(dataDir, 'workspaces', 'default', 'mcp-servers') });
  if (url.pathname === '/api/init') return send(response, 200, { success: true });
  if (url.pathname === '/kv' && request.method === 'GET') return send(response, 200, records);
  if (url.pathname === '/kv' && request.method === 'POST') {
    const update = JSON.parse(await body(request));
    records = { ...records, ...update, writtenBy: records.writtenBy ?? version };
    if (!(mode === 'memory-only-changes' && url.searchParams.get('stage') === 'change')) await persist();
    return send(response, 200, records);
  }
  if (url.pathname === '/backup') return send(response, 200, records);
  if (url.pathname === '/restore' && request.method === 'POST') {
    const restored = JSON.parse(await body(request));
    if (restored.damaged && mode !== 'accept-damaged') return send(response, 400, { error: 'damaged backup' });
    if (!restored.damaged) { records = restored; await persist(); }
    return send(response, 200, records);
  }
  return send(response, 404, { error: 'not found' });
});

if (helperPidFile) {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await writeFile(helperPidFile, String(helper.pid));
}
if (mode === 'ignore-stop') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
server.listen(port, '127.0.0.1');
