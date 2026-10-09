#!/usr/bin/env node
// Offline acceptance of an already-built official image. The application keeps
// its real CMD/ENTRYPOINT; the exec fixture is a generic process probe, not a Flow.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

const args = process.argv.slice(2);
assert.ok(args.length >= 1 && args.length <= 2 && !args[0].startsWith('-')
  && (args.length === 1 || args[1] === '--outer-init'),
'Usage: node scripts/smoke-official-container.mjs LOCAL_IMAGE [--outer-init]');
const outerInit = args.includes('--outer-init');
const owner = randomUUID(), name = `flujo-official-smoke-${owner}`;
const label = 'io.flujo.official-smoke-owner';
const fixture = '/app/data/.official-smoke';
const password = randomBytes(32).toString('base64url');
let deadline = Date.now() + 240_000;
let operator, container, imageId, createAttempted = false;
const evidence = { scope: 'official default application plus independent exec-origin lifecycle', outerInit };
const redact = value => String(value).replaceAll(password, '[redacted]')
  .replaceAll(operator?.token || '\0', '[redacted]');

async function docker(arguments_, { input, env = {}, timeout = 30_000, combineOutput = false } = {}) {
  const budget = Math.min(timeout, deadline - Date.now());
  if (budget <= 0) throw new Error('Official container acceptance deadline exceeded.');
  return new Promise((resolve, reject) => {
    const child = spawn('docker', arguments_, { windowsHide: true, env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), failure;
    const timer = setTimeout(() => { failure = new Error('Bounded Docker command timed out.'); child.kill(); }, budget);
    const collect = (which, bytes) => {
      if (failure) return;
      if (which === 'out') stdout = Buffer.concat([stdout, bytes]);
      else stderr = Buffer.concat([stderr, bytes]);
      if (stdout.length + stderr.length > 1_048_576) {
        failure = new Error('Docker response exceeded the evidence limit.'); child.kill();
      }
    };
    child.stdout.on('data', bytes => collect('out', bytes));
    child.stderr.on('data', bytes => collect('err', bytes));
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(new Error(redact(error.message))); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Docker command failed (${code}): ${redact(stderr.toString()).slice(-4000)}`));
      else resolve(combineOutput ? Buffer.concat([stdout, stderr]) : stdout);
    });
    child.stdin.end(input);
  });
}
const jsonDocker = async (...arguments_) => JSON.parse((await docker(arguments_)).toString());
const exec = (code, input, env = {}) => docker(['exec', '-i', '--user', '1000:1000',
  ...Object.keys(env).flatMap(key => ['--env', key]), container, 'node', '-e', code],
{ input: input === undefined ? undefined : JSON.stringify(input), env });
const execJson = async (...parameters) => JSON.parse((await exec(...parameters)).toString());

// Docker cp -a preserves these numeric owners. Seed before startup: production
// instrumentation validates authority before serving any request. The same bytes
// are then compared by UID 1000 through exec stdin before HTTP probes. Never
// truncate a policy that the genuine startup may already be reading.
function tarEntry(filename, content, mode, type = '0') {
  const body = Buffer.from(content), header = Buffer.alloc(512);
  const write = (offset, length, value) => header.write(String(value), offset, length, 'ascii');
  const octal = (offset, length, value) => write(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
  write(0, 100, filename); octal(100, 8, mode); octal(108, 8, 1000); octal(116, 8, 1000);
  octal(124, 12, body.length); octal(136, 12, Math.floor(Date.now() / 1000));
  header.fill(32, 148, 156); write(156, 1, type); write(257, 6, 'ustar\0'); write(263, 2, '00');
  const sum = header.reduce((total, byte) => total + byte, 0);
  write(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

async function inspectOwned() {
  assert.match(container, /^[a-f0-9]{64}$/);
  const [record] = await jsonDocker('inspect', container);
  assert.equal(record.Id, container); assert.equal(record.Image, imageId);
  assert.equal(record.Name, `/${name}`); assert.equal(record.Config.Labels?.[label], owner);
  assert.deepEqual(record.Config.Entrypoint, ['/usr/bin/tini', '-s', '--']);
  assert.deepEqual(record.Config.Cmd, ['node', 'scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '0.0.0.0']);
  assert.equal(record.HostConfig.NetworkMode, 'none');
  assert.equal(Boolean(record.HostConfig.Init), outerInit);
  assert.deepEqual(record.HostConfig.CapDrop, ['ALL']);
  assert.ok(record.HostConfig.SecurityOpt?.some(value => /^no-new-privileges(?:=true)?$/.test(value)));
  assert.deepEqual(record.Mounts, []); assert.ok(!Object.keys(record.HostConfig.PortBindings || {}).length);
  return record;
}
async function recoverCreated() {
  if (!createAttempted || container) return;
  const ids = (await docker(['ps', '-a', '--no-trunc', '--filter', `label=${label}=${owner}`,
    '--format', '{{.ID}}'])).toString().trim().split(/\s+/).filter(Boolean);
  assert.ok(ids.length <= 1, 'Ambiguous owned Docker create reply.');
  if (ids.length) { container = ids[0]; await inspectOwned(); }
}
async function poll(operation, accepted, milliseconds = 15_000) {
  const until = Math.min(Date.now() + milliseconds, deadline);
  while (Date.now() < until) {
    const value = await operation();
    if (accepted(value)) return value;
    await delay(100);
  }
  throw new Error('Bounded lifecycle/readiness poll exceeded its deadline.');
}

// Executed only inside the image. No environment, response bodies, or secrets
// are returned: receipts expose success/status and Linux process identities.
const apiCode = String.raw`
const fs=require('node:fs');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
 const response=await fetch('http://127.0.0.1:4200'+input.path,{
  method:input.action?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(4000),
  headers:{authorization:'Bearer '+process.env.FLUJO_HEALTHCHECK_TOKEN,...(input.action?{'content-type':'application/json'}:{})},
  ...(input.action?{body:JSON.stringify({action:input.action,...(input.password?{password:input.password}:{})})}:{})});
 const body=await response.json();console.log(JSON.stringify({status:response.status,success:body.success===true}));
})().catch(()=>{console.log(JSON.stringify({status:0,success:false}));process.exitCode=0});`;
const healthCode = String.raw`
const {spawnSync}=require('node:child_process'),env={...process.env,FLUJO_PORT:'4200'},mode=process.argv[1];
delete env.FLUJO_HEALTHCHECK_TOKEN;
if(mode==='correct')env.FLUJO_HEALTHCHECK_TOKEN=process.env.FLUJO_HEALTHCHECK_TOKEN;
if(mode==='wrong')env.FLUJO_HEALTHCHECK_TOKEN='synthetic-wrong-owner-token';
const result=spawnSync(process.execPath,['scripts/healthcheck.mjs'],{cwd:'/app',env,timeout:6000,maxBuffer:1024});
console.log(JSON.stringify({code:result.status,signal:result.signal,error:result.error?.code||null,
stdoutBytes:result.stdout?.length||0,stderrBytes:result.stderr?.length||0}));`;
async function health(mode) {
  const receipt = JSON.parse((await docker(['exec', '--user', '1000:1000', container, 'node', '-e', healthCode, mode])).toString());
  assert.ok([0, 1].includes(receipt.code)); assert.equal(receipt.signal, null); assert.equal(receipt.error, null);
  assert.equal(receipt.stdoutBytes, 0); assert.equal(receipt.stderrBytes, 0);
  return receipt.code === 0;
}
const snapshotCode = String.raw`
const fs=require('node:fs'),root='/app/data/.official-smoke';
function proc(pid){try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');
 const f=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
 return{pid:Number(pid),state:f[0],ppid:Number(f[1]),pgid:Number(f[2]),sid:Number(f[3]),birth:f[19],
 uid:Number(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/^Uid:\s+(\d+)/m)[1]),
 cmd:fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean)};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}}
const processes=fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x)).map(proc).filter(Boolean);
const receipts={};for(const tag of ['manager','parent','orphan','sibling','control']){
 try{const pid=Number(fs.readFileSync(root+'/'+tag+'.pid','utf8'));receipts[tag]={pid,process:proc(pid)};}catch{}
 for(const suffix of ['ready','exit','term']){try{receipts[tag+'.'+suffix]=JSON.parse(fs.readFileSync(root+'/'+tag+'.'+suffix,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}}}
console.log(JSON.stringify({processes,receipts}));`;
const snapshot = () => execJson(snapshotCode);
const sameLive = (original, current) => Boolean(current && current.pid === original.pid && current.birth === original.birth
  && current.uid === 1000 && !['Z', 'X', 'x'].includes(current.state));
const release = tag => exec(`require('node:fs').writeFileSync('${fixture}/${tag}.release','release',{flag:'wx',mode:0o600})`);

// These functions are serialized into CommonJS files inside the fixture only.
/* eslint-disable @typescript-eslint/no-require-imports */
function heldProcess() {
  const fs = require('node:fs'), http = require('node:http');
  const [root, tag] = process.argv.slice(2);
  const write = (suffix, value) => fs.writeFileSync(`${root}/${tag}.${suffix}`, JSON.stringify(value), { mode: 0o600 });
  fs.writeFileSync(`${root}/${tag}.pid`, String(process.pid), { mode: 0o600 });
  process.on('SIGTERM', () => write('term', { pid: process.pid, signal: 'SIGTERM' }));
  let server;
  if (tag === 'orphan') {
    server = http.createServer((request, response) => response.end('generic exec fixture'));
    server.listen(4202, '127.0.0.1', () => write('ready', { pid: process.pid }));
  } else write('ready', { pid: process.pid });
  const timer = setInterval(() => {
    if (!fs.existsSync(`${root}/${tag}.release`)) return;
    clearInterval(timer);
    const finish = () => { write('exit', { pid: process.pid, listenerClosed: Boolean(server), code: 0 }); process.exit(0); };
    if (server) server.close(finish); else finish();
  }, 30);
}
function transientParent() {
  const fs = require('node:fs'), { spawn } = require('node:child_process');
  const root = process.argv[2];
  fs.writeFileSync(`${root}/parent.pid`, String(process.pid), { mode: 0o600 });
  const child = spawn(process.execPath, [`${root}/held.cjs`, root, 'orphan'], { detached: true, stdio: 'ignore' });
  child.unref();
  setInterval(() => { if (fs.existsSync(`${root}/parent.release`)) process.exit(0); }, 30);
}
function probeManager() {
  const fs = require('node:fs'), { spawn } = require('node:child_process');
  const root = process.argv[2];
  fs.writeFileSync(`${root}/manager.pid`, String(process.pid), { mode: 0o600 });
  const children = [spawn(process.execPath, [`${root}/held.cjs`, root, 'sibling'], { stdio: 'ignore' }),
    spawn(process.execPath, [`${root}/held.cjs`, root, 'control'], { detached: true, stdio: 'ignore' })];
  const parent = spawn(process.execPath, [`${root}/parent.cjs`, root], { stdio: 'ignore' });
  parent.once('exit', (code, signal) => fs.writeFileSync(`${root}/parent.exit`, JSON.stringify({ pid: parent.pid, code, signal }), { mode: 0o600 }));
  process.on('SIGTERM', () => fs.writeFileSync(`${root}/manager.term`, JSON.stringify({ pid: process.pid, signal: 'SIGTERM' }), { mode: 0o600 }));
  const timer = setInterval(() => {
    if (fs.existsSync(`${root}/manager.release`) && children.every(child => child.exitCode === 0)) {
      clearInterval(timer); process.exit(0);
    }
  }, 30);
}
/* eslint-enable @typescript-eslint/no-require-imports */

try {
  const [image] = await jsonDocker('image', 'inspect', args[0]);
  imageId = image.Id; assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image.Os, 'linux'); assert.ok(['node', '1000', '1000:1000'].includes(image.Config.User));
  assert.equal(image.Config.WorkingDir, '/app');
  assert.deepEqual(image.Config.Entrypoint, ['/usr/bin/tini', '-s', '--']);
  assert.deepEqual(image.Config.Cmd, ['node', 'scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '0.0.0.0']);
  assert.deepEqual(image.Config.Healthcheck?.Test, ['CMD', 'node', 'scripts/healthcheck.mjs']);
  operator = await createSmokeOperator();
  const policy = await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE);
  const environment = { FLUJO_OWNER_AUTH_FILE: `${fixture}/owner.json`, FLUJO_HEALTHCHECK_TOKEN: operator.token,
    FLUJO_DATA_DIR: '/app/data', FLUJO_EXPOSURE_MODE: 'localhost', NEXT_TELEMETRY_DISABLED: '1',
    DEBUG: 'next:start-server', DEBUG_COLORS: '0' };
  createAttempted = true;
  const created = (await docker(['create', '--pull=never', '--name', name, '--label', `${label}=${owner}`,
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...(outerInit ? ['--init'] : []),
    ...Object.keys(environment).flatMap(key => ['--env', key]), imageId], { env: environment })).toString().trim();
  assert.match(created, /^[a-f0-9]{64}$/); container = created;
  await inspectOwned();
  const archive = Buffer.concat([tarEntry('.official-smoke/', '', 0o700, '5'),
    tarEntry('.official-smoke/owner.json', policy, 0o600), Buffer.alloc(1024)]);
  await docker(['cp', '-a', '-', `${container}:/app/data`], { input: archive });
  await docker(['start', container]);
  const binding = await execJson(String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');const root='/app/data/.official-smoke';
if(process.getuid()!==1000)throw Error('Expected image UID 1000');
for(const [file,mode]of [[root,448],[root+'/owner.json',384]]){const s=fs.lstatSync(file);if(s.isSymbolicLink()||s.uid!==1000||(s.mode&511)!==mode)throw Error('Private policy ownership mismatch');}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(fs.readFileSync(root+'/owner.json','utf8')!==input.policy)throw Error('Seeded owner policy bytes mismatch');
const b=JSON.parse(fs.readFileSync('/app/scripts/generated-smoke-owner-issuer.json','utf8'));
const digest=crypto.createHash('sha256').update(fs.readFileSync('/app/scripts/generated-smoke-owner-issuer.cjs')).digest('hex');
if(b.schemaVersion!==1||digest!==b.compiledSha256)throw Error('Image issuer binding mismatch');
console.log(JSON.stringify({sourceSha256:b.sourceSha256,compiledSha256:digest,uid:process.getuid()}));`, { policy: policy.toString() });
  assert.equal(binding.sourceSha256, operator.issuerSourceSha256);
  evidence.imageId = imageId; evidence.issuer = binding;
  evidence.revision = image.Config.Labels?.['org.opencontainers.image.revision'] || null;
  assert.match(evidence.revision, /^[a-f0-9]{40}$/, 'Require the full image application revision.');
  evidence.hostProbeSha256 = createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex');
  await poll(() => execJson(apiCode, { path: '/api/encryption/secure', action: 'status' }), value => value.status === 200, 60_000);
  assert.equal((await execJson(apiCode, { path: '/api/cwd' })).status, 423);
  assert.equal(await health('correct'), false);
  assert.deepEqual(await execJson(apiCode, { path: '/api/encryption/secure', action: 'initialize', password }), { status: 200, success: true });
  assert.equal(await health('correct'), false);
  assert.deepEqual(await execJson(apiCode, { path: '/api/encryption/secure', action: 'authenticate', password }), { status: 200, success: true });
  assert.equal(await health('missing'), false); assert.equal(await health('wrong'), false); assert.equal(await health('correct'), true);
  evidence.health = { locked423: true, initializedStillLocked: true, authenticated: true, missingRejected: true, wrongRejected: true };
  const healthy = await poll(inspectOwned, record => record.State.Health?.Status === 'healthy', 60_000);
  assert.ok(healthy.State.Health.Log?.some(value => value.ExitCode === 0));
  evidence.health.dockerStatus = healthy.State.Health.Status;
  evidence.health.cliSilentExitContract = true;

  const graph = await snapshot();
  const launcher = graph.processes.find(value => /(?:^|\/)node$/.test(value.cmd[0])
    && value.cmd[1]?.endsWith('scripts/launch-next.mjs'));
  assert.ok(launcher && launcher.uid === 1000);
  const tini = graph.processes.find(value => value.pid === launcher.ppid);
  assert.ok(tini && tini.uid === 1000 && tini.cmd[0] === '/usr/bin/tini' && tini.cmd.includes('-s'));
  const next = graph.processes.find(value => value.ppid === launcher.pid && value.cmd[0]?.startsWith('next-server'));
  assert.ok(next && next.uid === 1000);
  if (outerInit) { assert.notEqual(tini.pid, 1); assert.equal(tini.ppid, 1); }
  else assert.equal(tini.pid, 1);
  const namespaceInit = graph.processes.find(value => value.pid === 1);
  assert.ok(namespaceInit && namespaceInit.uid === 1000);
  if (outerInit) assert.match(namespaceInit.cmd[0], /(?:^|\/)docker-init$/);
  else assert.equal(namespaceInit.birth, tini.birth);
  evidence.application = { tini, launcher, next };
  await exec(String.raw`
const fs=require('node:fs'),root='/app/data/.official-smoke';const files=JSON.parse(fs.readFileSync(0,'utf8'));
for(const[name,code]of Object.entries(files))fs.writeFileSync(root+'/'+name,code,{flag:'wx',mode:384});`,
  { 'held.cjs': `(${heldProcess.toString()})();`, 'parent.cjs': `(${transientParent.toString()})();`, 'manager.cjs': `(${probeManager.toString()})();` });
  await docker(['exec', '-d', '--user', '1000:1000', container, 'node', `${fixture}/manager.cjs`, fixture]);
  const before = await poll(snapshot, value => ['manager', 'parent', 'orphan', 'sibling', 'control'].every(tag => value.receipts[tag]?.process)
    && value.receipts['orphan.ready']);
  const receipt = tag => before.receipts[tag].process;
  assert.equal(receipt('orphan').ppid, receipt('parent').pid);
  assert.equal(receipt('parent').ppid, receipt('manager').pid);
  assert.equal(receipt('sibling').ppid, receipt('manager').pid);
  assert.equal(receipt('sibling').pgid, receipt('parent').pgid);
  for (const tag of ['orphan', 'control']) {
    assert.equal(receipt(tag).pgid, receipt(tag).pid); assert.equal(receipt(tag).sid, receipt(tag).pid);
  }
  for (const tag of ['manager', 'parent', 'orphan', 'sibling', 'control']) assert.ok(sameLive(receipt(tag), receipt(tag)));
  assert.equal(await execJson(String.raw`
(async()=>{const response=await fetch('http://127.0.0.1:4202',{signal:AbortSignal.timeout(1000)});
 console.log(JSON.stringify(response.ok&&(await response.text())==='generic exec fixture'));})().catch(()=>console.log('false'));`), true);
  await release('parent');
  const adopted = await poll(snapshot, value => value.receipts['parent.exit']
    && !value.receipts.parent.process && value.receipts.orphan.process?.ppid === namespaceInit.pid);
  assert.deepEqual(adopted.receipts['parent.exit'], { pid: receipt('parent').pid, code: 0, signal: null });
  assert.ok(sameLive(namespaceInit, adopted.processes.find(value => value.pid === namespaceInit.pid)));
  assert.ok(sameLive(receipt('orphan'), adopted.receipts.orphan.process));
  assert.equal(await health('correct'), true);
  await release('orphan');
  const reaped = await poll(snapshot, value => value.receipts['orphan.exit'] && !value.receipts.orphan.process);
  assert.deepEqual(reaped.receipts['orphan.exit'], { pid: receipt('orphan').pid, listenerClosed: true, code: 0 });
  assert.equal(await execJson(String.raw`
const net=require('node:net');const socket=net.connect(4202,'127.0.0.1');socket.setTimeout(1000);
socket.once('connect',()=>{console.log('false');socket.destroy()});socket.once('error',e=>console.log(JSON.stringify(e.code==='ECONNREFUSED')));
socket.once('timeout',()=>{console.log('false');socket.destroy()});`), true);
  for (const tag of ['sibling', 'control']) {
    assert.ok(sameLive(receipt(tag), reaped.receipts[tag].process)); assert.equal(reaped.receipts[`${tag}.term`], undefined);
  }
  assert.equal(await health('correct'), true);
  evidence.execLifecycle = { before: before.receipts, adopted: adopted.receipts, reaped: reaped.receipts,
    adopter: namespaceInit, adoptionScope: 'exec-origin namespace init; outside inner subreaper ancestry',
    directWait: true, sameBirthAdoption: true, listenerClosed: true, pidAbsent: true, independentControlsUnsignalled: true };
  for (const tag of ['sibling', 'control', 'manager']) await release(tag);
  await poll(snapshot, value => ['manager', 'sibling', 'control'].every(tag => !value.receipts[tag].process));
  assert.equal(await health('correct'), true);

  // Real Docker SIGTERM -> image tini -> actual launcher -> actual Next. No
  // SIGKILL fallback: a hung application remains owned and available to inspect.
  await inspectOwned();
  const finalGraph = await snapshot();
  for (const original of [tini, launcher, next]) {
    assert.ok(sameLive(original, finalGraph.processes.find(value => value.pid === original.pid)));
  }
  const cleanupMarkers = async () => {
    const logs = (await docker(['logs', '--tail', '200', container], { timeout: 5000, combineOutput: true })).toString();
    assert.ok(!logs.includes(operator.token) && !logs.includes(password), 'Application logs must not expose test credentials.');
    return logs.split(/\r?\n/).map(line => line.match(/\bnext:start-server\s+(start-server process cleanup(?: finished)?)(?:\s+\+\S+)?\s*$/)?.[1]).filter(Boolean);
  };
  assert.deepEqual(await cleanupMarkers(), []);
  const shutdownStarted = Date.now();
  await docker(['kill', '--signal=TERM', container]);
  const stopped = await poll(inspectOwned, record => !record.State.Running, 20_000);
  assert.ok([0, 143].includes(stopped.State.ExitCode)); assert.equal(stopped.State.OOMKilled, false);
  assert.equal(stopped.State.Dead, false); assert.equal(stopped.State.Error, '');
  assert.notEqual(stopped.State.FinishedAt, '0001-01-01T00:00:00Z');
  const shutdownElapsed = Date.now() - shutdownStarted;
  assert.ok(shutdownElapsed < 9000, 'Shutdown must precede the launcher 10-second SIGKILL fallback.');
  assert.deepEqual(await cleanupMarkers(), ['start-server process cleanup', 'start-server process cleanup finished']);
  evidence.shutdown = { signal: 'SIGTERM', exitCode: stopped.State.ExitCode, oomKilled: false,
    elapsedMs: shutdownElapsed, nextCleanupStarted: true, nextCleanupFinished: true,
    healthClosed: 'application process chain and isolated network namespace stopped' };
  await inspectOwned();
  await docker(['rm', container]);
  // Verify removal by the unique ownership label, including uncertain rm reply.
  const remaining = (await docker(['ps', '-a', '--no-trunc', '--filter', `label=${label}=${owner}`, '--format', '{{.ID}}'])).toString().trim();
  assert.equal(remaining, '');
  await operator.restore();
  console.log(JSON.stringify({ result: 'PASS', ...evidence }));
} catch (error) {
  // Retain owned handles on any uncertainty. Never enumerate/remove other users'
  // containers, volumes, images or workspaces; never print Docker Config.Env.
  // Operations cannot borrow this separate, bounded evidence/recovery budget.
  deadline = Date.now() + 30_000;
  const diagnostic = { result: 'FAIL', reason: redact(error.message), owner, container: container || null, imageId, evidence };
  try { await recoverCreated(); diagnostic.container = container || null; }
  catch (recovery) { diagnostic.recovery = redact(recovery.message); }
  if (container) {
    try { const record = await inspectOwned(); diagnostic.state = {
      running: record.State.Running, exitCode: record.State.ExitCode, oomKilled: record.State.OOMKilled,
      dead: record.State.Dead, error: redact(record.State.Error), finishedAt: record.State.FinishedAt };
      diagnostic.logs = redact((await docker(['logs', '--tail', '100', container], { timeout: 5000, combineOutput: true })).toString()).slice(-32_000);
    } catch (inspection) { diagnostic.inspection = redact(inspection.message); }
  }
  if (operator) {
    const location = path.join(path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE), 'official-container-diagnostic.json');
    try { await fs.writeFile(location, JSON.stringify(diagnostic, null, 2), { flag: 'wx', mode: 0o600 });
      console.error(`Private redacted diagnostics retained: ${location}`);
    } catch { console.error('Private diagnostic write failed; owned resource handles retained.'); }
  }
  console.error(JSON.stringify({ result: 'FAIL', reason: diagnostic.reason, container: diagnostic.container, owner }));
  process.exitCode = 1;
}
