// Local init acceptance. This synthetic listener is not a FLUJO image smoke.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const [image, ...flags] = process.argv.slice(2);
assert.ok(image && !image.startsWith('-'), 'Usage: node scripts/test-container-init.mjs IMAGE [--outer-init] [--expect-zombie] [--direct-node]');
const allowed = new Set(['--outer-init', '--expect-zombie', '--direct-node']);
assert.ok(flags.every(flag => allowed.has(flag)) && new Set(flags).size === flags.length, 'Unknown or duplicate option');
const expectZombie = flags.includes('--expect-zombie');
const directNode = flags.includes('--direct-node');
const owner = randomUUID();
const name = `flujo-init-test-${owner}`;
let activeDeadline;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: activeDeadline ? Math.max(1, Math.min(30_000, activeDeadline - Date.now())) : 30_000, maxBuffer: 1024 * 1024 }).trim();
const imageId = JSON.parse(docker('image', 'inspect', image))[0].Id;
const child = `const fs=require('fs');const server=require('http').createServer((q,s)=>s.end('descendant alive')).listen(4202,'127.0.0.1');server.on('listening',()=>{fs.writeFileSync('/tmp/orphan.pid',String(process.pid));const timer=setInterval(()=>{if(fs.existsSync('/tmp/orphan.release')){clearInterval(timer);server.close(()=>{fs.writeFileSync('/tmp/orphan.exit','listener closed');process.exit(0)})}},25)});`;
// Executable sources are fixed; nested programs and values travel as argv data,
// never as escaped fragments interpolated into another JavaScript program.
const parent = `const fs=require('fs');const {spawn}=require('child_process');fs.writeFileSync('/tmp/parent.pid',String(process.pid));spawn(process.execPath,['-e',process.argv[1]],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{if(fs.existsSync('/tmp/parent.release'))process.exit(0)},25);`;
const control = `const fs=require('fs');const label=process.argv[1];if(!['control','sibling'].includes(label))throw new Error('Invalid control');fs.writeFileSync('/tmp/'+label+'.pid',String(process.pid));process.on('SIGTERM',()=>fs.writeFileSync('/tmp/'+label+'.term','received'));setInterval(()=>{},1000);`;
const main = `const fs=require('fs');const {spawn}=require('child_process');const programs=JSON.parse(process.argv[1]);fs.writeFileSync('/tmp/main.pid',String(process.pid));spawn(process.execPath,['-e',programs.control,'control'],{detached:true,stdio:'ignore'}).unref();spawn(process.execPath,['-e',programs.control,'sibling'],{stdio:'ignore'}).unref();const server=require('http').createServer((q,s)=>s.end('alive')).listen(4200,'127.0.0.1');server.on('listening',()=>spawn(process.execPath,['-e',programs.parent,programs.child],{stdio:'ignore'}).once('exit',(code,signal)=>fs.writeFileSync('/tmp/parent.exit',JSON.stringify({code,signal}))));process.on('SIGTERM',()=>{fs.writeFileSync('/tmp/main.term','received');server.close(()=>{console.log('LISTENER_CLOSED');setInterval(()=>{if(fs.existsSync('/tmp/main.release')){console.log('GRACEFUL_SHUTDOWN');process.exit(0)}},25)})});`;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(read, accepts, description) {
  const deadline = Date.now() + 15_000;
  const previousDeadline = activeDeadline;
  activeDeadline = deadline;
  let last;
  try {
    do { last = read(); if (accepts(last)) return last; await pause(); } while (Date.now() < deadline);
    assert.fail(`Timed out: ${description}; last=${JSON.stringify(last)}`);
  } finally { activeDeadline = previousDeadline; }
}
let containerId;
const inspect = () => JSON.parse(docker('inspect', containerId))[0];
const execute = (code, ...args) => docker('exec', containerId, 'node', '-e', code, ...args);
const readFile = file => execute(`const fs=require('fs');try{process.stdout.write(fs.readFileSync(process.argv[1],'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}`, file);
const snapshot = pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Invalid process ID');
  return JSON.parse(execute(`const fs=require('fs');const pid=Number(process.argv[1]);if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid process ID');try{const raw=fs.readFileSync('/proc/'+pid+'/stat','utf8');const f=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\\s+/);const status=fs.readFileSync('/proc/'+pid+'/status','utf8');process.stdout.write(JSON.stringify({pid,state:f[0],ppid:Number(f[1]),pgid:Number(f[2]),sid:Number(f[3]),birth:f[19],uid:Number(status.match(/^Uid:\\s+(\\d+)/m)[1]),command:fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean)}))}catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('null')}`, String(pid)));
};
const sameLive = (current, original, label) => {
  assert.ok(current && current.birth === original.birth && !['Z', 'X', 'x'].includes(current.state), `${label} is absent, replaced or terminated`);
  assert.ok(current.uid > 0, `${label} is running as root`);
};
const release = label => {
  assert.ok(['parent', 'orphan', 'main'].includes(label), 'Invalid release target');
  return execute(`require('fs').writeFileSync('/tmp/'+process.argv[1]+'.release','release')`, label);
};
try {
  containerId = docker('run', '-d', '--pull=never', '--name', name, '--label', `io.flujo.init-test-owner=${owner}`, '--network', 'none', '--read-only', '--no-healthcheck',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16777216', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(flags.includes('--outer-init') ? ['--init'] : []), ...(directNode ? ['--entrypoint', 'node'] : []), imageId,
    ...(directNode ? ['-e', main] : ['node', '-e', main]), JSON.stringify({ child, parent, control }));
  const pids = {};
  for (const label of ['main', 'parent', 'orphan', 'control', 'sibling']) {
    pids[label] = Number(await until(() => readFile(`/tmp/${label}.pid`), value => /^\d+$/.test(value), `${label} readiness`));
  }
  const before = Object.fromEntries(Object.entries(pids).map(([label, pid]) => [label, snapshot(pid)]));
  for (const [label, current] of Object.entries(before)) sameLive(current, current, label);
  assert.equal(before.orphan.ppid, pids.parent, 'Held orphan was not the transient parent\'s descendant');
  assert.equal(before.parent.ppid, pids.main, 'Transient parent did not belong to the main process');
  assert.equal(before.control.ppid, pids.main, 'Independent control did not belong to the main process');
  assert.equal(before.sibling.ppid, pids.main, 'Independent sibling did not belong to the main process');
  assert.equal(before.sibling.pgid, before.main.pgid, 'Independent sibling did not share the main process group');
  assert.equal(before.sibling.sid, before.main.sid, 'Independent sibling did not share the main session');
  for (const label of ['orphan', 'control']) {
    assert.equal(before[label].sid, pids[label], `${label} did not create a detached session`);
    assert.equal(before[label].pgid, pids[label], `${label} did not create a detached process group`);
  }
  assert.equal(execute("require('http').get('http://127.0.0.1:4202',r=>r.pipe(process.stdout)).on('error',e=>{throw e})"), 'descendant alive');
  release('parent');
  assert.deepEqual(JSON.parse(await until(() => readFile('/tmp/parent.exit'), value => value !== '', 'direct parent exit receipt')), {code: 0, signal: null});
  assert.equal(snapshot(pids.parent), null, 'Main did not reap its direct child');
  const adopted = await until(() => snapshot(pids.orphan), value => value && value.ppid !== pids.parent, 'live descendant adoption');
  sameLive(adopted, before.orphan, 'Adopted orphan');
  const adopter = snapshot(adopted.ppid);
  assert.ok(adopter, 'Adopter is absent');
  if (expectZombie) {
    assert.equal(adopted.ppid, pids.main, 'Negative control did not adopt into the Node main process');
    assert.equal(pids.main, 1, 'Negative control requires Node PID 1 without an init');
  } else {
    assert.ok(adopter.command[0]?.endsWith('/tini'), 'Held descendant was not adopted by the image\'s Tini');
    assert.ok(adopter.uid > 0, 'Image Tini is running as root');
    assert.equal(before.main.ppid, adopted.ppid, 'Descendant was adopted outside the image\'s inner init');
    if (flags.includes('--outer-init')) assert.notEqual(adopted.ppid, 1, 'Nested case did not exercise inner subreaper adoption');
  }
  release('orphan');
  assert.equal(await until(() => readFile('/tmp/orphan.exit'), value => value === 'listener closed', 'descendant listener closure receipt'), 'listener closed');
  assert.equal(execute("require('http').get('http://127.0.0.1:4202',r=>{r.resume();process.stdout.write('open')}).on('error',e=>{if(e.code!=='ECONNREFUSED')throw e;process.stdout.write('closed')})"), 'closed');
  const after = await until(() => {
    const current = snapshot(pids.orphan);
    if (current) assert.equal(current.birth, before.orphan.birth, 'Descendant PID was reused during exit observation');
    return current;
  }, value => expectZombie ? value?.state === 'Z' : value === null,
    expectZombie ? 'same-identity zombie negative control' : 'terminated descendant reaping');
  if (expectZombie) {
    assert.equal(after.birth, before.orphan.birth, 'Negative control observed a reused PID');
    assert.equal(after.ppid, pids.main, 'Zombie has the wrong adopter');
  }
  assert.equal(inspect().State.Running, true, 'Main stopped during orphan reaping');
  sameLive(snapshot(pids.main), before.main, 'Main after orphan termination');
  sameLive(snapshot(pids.control), before.control, 'Detached control after orphan termination');
  sameLive(snapshot(pids.sibling), before.sibling, 'Independent sibling after orphan termination');
  assert.equal(execute("require('http').get('http://127.0.0.1:4200',r=>r.pipe(process.stdout)).on('error',e=>{throw e})"), 'alive');
  docker('kill', '--signal', 'TERM', containerId);
  await until(() => readFile('/tmp/main.term'), value => value === 'received', 'main SIGTERM forwarding');
  await until(() => execute("require('http').get('http://127.0.0.1:4200',r=>{r.resume();process.stdout.write('open')}).on('error',e=>{if(e.code!=='ECONNREFUSED')throw e;process.stdout.write('closed')})"), value => value === 'closed', 'listener closure');
  sameLive(snapshot(pids.main), before.main, 'Main during cooperative shutdown');
  sameLive(snapshot(pids.control), before.control, 'Independent detached control during shutdown');
  assert.equal(readFile('/tmp/control.term'), '', 'SIGTERM was broadcast to the independent detached session');
  sameLive(snapshot(pids.sibling), before.sibling, 'Independent sibling during shutdown');
  assert.equal(readFile('/tmp/sibling.term'), '', 'SIGTERM was broadcast to an independent sibling in the main process group');
  release('main');
  await until(() => inspect().State, state => state.Running === false, 'graceful container exit');
  assert.equal(inspect().State.ExitCode, 0, 'Main/init did not preserve the graceful exit code');
  assert.match(docker('logs', containerId), /GRACEFUL_SHUTDOWN/);
  console.log(JSON.stringify({ image, imageId, outerInit: flags.includes('--outer-init'), directNode, nonRootUid: before.main.uid,
    descendantBirth: before.orphan.birth, adopterPid: adopted.ppid, adopterExecutable: adopter.command[0],
    orphan: expectZombie ? 'same-identity zombie (negative control)' : 'absent /proc entry after termination',
    listener: 'alive after reaping, closed after SIGTERM', independentControls: 'detached and shared-group controls retain identity and receive no SIGTERM before container exit', gracefulExitCode: 0,
    qualification: 'synthetic init lifecycle; not full FLUJO startup/recovery' }));
} finally {
  if (!containerId) {
    const recovered = docker('ps', '--all', '--filter', `label=io.flujo.init-test-owner=${owner}`, '--filter', `name=^/${name}$`, '--format', '{{.ID}}');
    if (recovered) {
      assert.ok(!recovered.includes('\n'), 'Ambiguous container ownership during creation recovery');
      containerId = JSON.parse(docker('inspect', recovered))[0].Id;
    }
  }
  if (containerId) {
    const current = inspect();
    assert.equal(current.Config.Labels['io.flujo.init-test-owner'], owner, 'Refusing cleanup of a container with different ownership');
    assert.equal(current.Image, imageId, 'Refusing cleanup of a container with a different image');
    docker('rm', '-f', containerId);
  }
}
