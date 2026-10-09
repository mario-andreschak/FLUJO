// Local lifecycle acceptance: real adopted orphan, proc identity and signal forwarding.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const image = process.argv[2];
assert.ok(image && !image.startsWith('-'), 'Usage: node scripts/test-container-init.mjs IMAGE [--outer-init] [--expect-zombie]');
const name = `flujo-init-test-${randomUUID()}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const expectZombie = process.argv.includes('--expect-zombie');
const child = `const fs=require('fs');fs.writeFileSync('/tmp/orphan.pid',String(process.pid));setTimeout(()=>process.exit(0),1500);`;
const parent = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});child.unref();`;
const main = `const {spawn}=require('child_process');const server=require('http').createServer((q,s)=>s.end('alive')).listen(4200,'127.0.0.1');server.on('listening',()=>spawn(process.execPath,['-e',${JSON.stringify(parent)}],{stdio:'ignore'}));process.on('SIGTERM',()=>server.close(()=>{console.log('GRACEFUL_SHUTDOWN');process.exit(0)}));`;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const inspect = () => JSON.parse(docker('inspect', name))[0];
try {
  docker('run', '-d', '--name', name, '--network', 'none', '--read-only', '--no-healthcheck',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=16777216', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(process.argv.includes('--outer-init') ? ['--init'] : []), image, 'node', '-e', main);
  let pid;
  for (let attempt = 0; attempt < 40 && !pid; attempt++) {
    const value = docker('exec', name, 'node', '-e', "const fs=require('fs');if(fs.existsSync('/tmp/orphan.pid'))process.stdout.write(fs.readFileSync('/tmp/orphan.pid')); ");
    if (value) pid = Number(value);
    else await pause();
  }
  assert.ok(Number.isInteger(pid) && pid > 1, 'Orphan did not start');
  const readStat = () => docker('exec', name, 'node', '-e', `const fs=require('fs');try{process.stdout.write(fs.readFileSync('/proc/${pid}/stat','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}`);
  const before = readStat();
  assert.ok(before, 'Orphan exited before live identity observation');
  const beforeFields = before.slice(before.lastIndexOf(')') + 2).split(' ');
  const identity = beforeFields[19];
  let after;
  for (let attempt = 0; attempt < 50; attempt++) {
    after = readStat();
    if (!after || after.slice(after.lastIndexOf(')') + 2).split(' ')[0] === 'Z') break;
    await pause();
  }
  // Give the init a bounded opportunity to reap, never equate zombie with absent PID.
  if (!expectZombie) for (let attempt = 0; attempt < 20 && after; attempt++) { await pause(); after = readStat(); }
  if (expectZombie) {
    const fields = after.slice(after.lastIndexOf(')') + 2).split(' ');
    assert.equal(fields[0], 'Z'); assert.equal(fields[19], identity);
  } else assert.equal(after, '', 'Terminated orphan remains in /proc');
  assert.equal(inspect().State.Running, true, 'Main application stopped while reaping');
  assert.equal(docker('exec', name, 'node', '-e', "require('http').get('http://127.0.0.1:4200',r=>r.pipe(process.stdout))"), 'alive');
  docker('stop', '--time', '5', name);
  assert.equal(inspect().State.ExitCode, 0, 'SIGTERM did not reach application');
  assert.match(docker('logs', name), /GRACEFUL_SHUTDOWN/);
  console.log(JSON.stringify({ image, nonRootUser: inspect().Config.User, orphan: expectZombie ? 'same-identity zombie (negative control)' : 'reaped', gracefulShutdown: true }));
} finally { docker('rm', '-f', name); }
