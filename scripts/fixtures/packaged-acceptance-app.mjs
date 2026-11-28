// A tiny stand-in for an installed FLUJO, used by packaged-acceptance.test.mjs
// to exercise real start, stop, crash and restart handling without a build.
// While the file named by --full-marker exists, the "disk" is full: writes
// fail as a real full disk makes them fail. FIXTURE_MODE selects one fault:
//   memory-only-changes  keeps writes sent with ?stage=change in memory only
//   accept-damaged       answers 200 to a damaged backup
//   ignore-old-data      starts empty when the data was written by another version
//   ignore-stop          ignores SIGTERM
//   exit-early           prints a message and exits before listening
//   backup-lock          a backup leaves a lock behind that blocks writes after a crash
//   crash-when-full      exits when a write meets the full disk
//   lie-when-full        confirms writes on a full disk without keeping them
//   corrupt-when-full    empties a value when its write meets the full disk
//   stuck-after-full     refuses every write after the first one met the full disk
//   forget-schedules     does not start its schedule again after a restart
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const argument = name => process.argv[process.argv.indexOf(name) + 1];
const port = Number(argument('--port'));
const dataDir = argument('--data');
const fullMarker = process.argv.includes('--full-marker') ? argument('--full-marker') : undefined;
const helperPidFile = process.argv.includes('--helper-pid-file') ? argument('--helper-pid-file') : undefined;
const mode = process.env.FIXTURE_MODE ?? '';
const version = process.env.FIXTURE_VERSION ?? '1';
const file = path.join(dataDir, 'records.json');
const lock = path.join(dataDir, 'backup.lock');

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

let stuck = false;
const diskFull = () => Boolean(fullMarker && existsSync(fullMarker));
class DiskFull extends Error { constructor() { super('ENOSPC: no space left on device'); this.code = 'ENOSPC'; } }

async function persist() {
  if (diskFull()) throw new DiskFull();
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

/** Apply a change the way each fault mode would; answers the HTTP status. */
async function write(update, stage) {
  if (stuck) return 507;
  if (existsSync(lock)) return 423;
  const before = records;
  records = { ...records, ...update, writtenBy: records.writtenBy ?? version };
  if (mode === 'memory-only-changes' && stage === 'change') return 200;
  if (diskFull()) {
    if (mode === 'crash-when-full') process.exit(70);
    if (mode === 'lie-when-full') { records = before; return 200; }
    if (mode === 'corrupt-when-full') records = { ...before, ...Object.fromEntries(Object.keys(update).map(key => [key, ''])) };
    else records = before;
    if (mode === 'stuck-after-full') stuck = true;
    return 507;
  }
  try { await persist(); } catch { records = before; return 507; }
  return 200;
}

let scheduleTimer;
function armSchedule() {
  clearInterval(scheduleTimer);
  const schedule = records.schedule;
  if (!schedule) return;
  scheduleTimer = setInterval(async () => {
    const firedAt = new Date().toISOString();
    try {
      await fetch(`${schedule.modelUrl}/chat/completions`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${schedule.key}` },
        body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: `Acceptance marker: schedule.\n{"now": "${firedAt}"}` }] }) });
      records.runs = [...(records.runs ?? []), firedAt];
      await persist();
    } catch { /* the next tick tries again */ }
  }, schedule.intervalMs);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/api/cwd') return send(response, 200, { cwd: process.cwd(), mcpServersDir: path.join(dataDir, 'workspaces', 'default', 'mcp-servers') });
  if (url.pathname === '/api/init') return send(response, 200, { success: true });
  if (url.pathname === '/kv' && request.method === 'GET') return send(response, 200, records);
  if (url.pathname === '/kv' && request.method === 'POST') {
    const status = await write(JSON.parse(await body(request)), url.searchParams.get('stage'));
    return send(response, status, records);
  }
  if (url.pathname === '/backup') {
    if (existsSync(lock)) return send(response, 423, { error: 'a backup is under way' });
    if (mode === 'backup-lock') await writeFile(lock, 'backup under way');
    if (url.searchParams.get('slow')) await new Promise(resolve => setTimeout(resolve, 5_000));
    if (mode === 'backup-lock') await rm(lock, { force: true });
    return send(response, 200, records);
  }
  if (url.pathname === '/restore' && request.method === 'POST') {
    const restored = JSON.parse(await body(request));
    if (restored.damaged && mode !== 'accept-damaged') return send(response, 400, { error: 'damaged backup' });
    if (!restored.damaged) { records = restored; await persist(); }
    return send(response, 200, records);
  }
  if (url.pathname === '/automation' && request.method === 'POST') {
    records.schedule = JSON.parse(await body(request));
    await persist();
    armSchedule();
    return send(response, 200, records.schedule);
  }
  return send(response, 404, { error: 'not found' });
});

if (helperPidFile) {
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await writeFile(helperPidFile, String(helper.pid));
}
if (mode !== 'forget-schedules') armSchedule();
if (mode === 'ignore-stop') process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => { clearInterval(scheduleTimer); server.close(() => process.exit(0)); server.closeAllConnections(); });
server.listen(port, '127.0.0.1');
