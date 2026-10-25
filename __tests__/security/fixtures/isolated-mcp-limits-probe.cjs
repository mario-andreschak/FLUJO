// Explicit local-image negative controls. No pulls, builds or user credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const source = path.resolve(__dirname, '../../../src/backend/services/security/isolatedMcp.ts');
const allowed = new Set(['isolatedMcp.ts', 'isolatedMcpInspection.ts', 'windowsPrivateAuthority.ts']
  .map(name => path.join(path.dirname(source), name)));
require.extensions['.ts'] = (module, filename) => {
  if (!allowed.has(filename)) throw new Error('Unexpected source module');
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { createIsolatedMcpLaunch, isolatedMcpPolicyDigest } = require(source);
const [dockerExecutable, daemon, image] = process.argv.slice(2);
const parent = path.resolve(os.tmpdir());
const workspace = fs.mkdtempSync(path.join(parent, 'flujo-mcp-limits-'));

async function probe(name, program) {
  const policy = { schemaVersion: 1, kind: 'docker-deny-egress', dockerExecutable, daemon, image,
    command: ['node', '-e', program], environmentNames: [], mounts: [], memoryMiB: 128, cpus: 0.5, pidsLimit: 32 };
  const launch = createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace);
  let status = 0, stdout = '';
  try {
    try {
      stdout = execFileSync(launch.command, [...launch.args], { env: launch.env, cwd: launch.cwd,
        windowsHide: true, timeout: 10_000, encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { status = error.status; }
    const state = JSON.parse(execFileSync(launch.command, [...launch.args.slice(0, 4), 'container', 'inspect',
      launch.containerId, '--format', '{{json .State}}'], { env: launch.env, windowsHide: true, timeout: 5000, encoding: 'utf8' }));
    assert.equal(state.Running, false);
    if (name === 'memory') {
      assert.equal(status, 137);
      assert.equal(state.ExitCode, 137);
      assert.equal(state.OOMKilled, true);
    } else {
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.ok(result.started > 0 && result.denied > 0);
      assert.equal(result.started + result.denied, 40);
      assert.deepEqual(result.errors, ['EAGAIN']);
    }
    console.log(JSON.stringify({ limitProbe: name, status, oomKilled: state.OOMKilled,
      ...(name === 'pids' ? JSON.parse(stdout) : {}) }));
  } finally {
    const cleanup = launch.close();
    console.log(JSON.stringify({ limitProbe: name, cleanup: cleanup.outcome }));
    assert.notEqual(cleanup.outcome, 'unknown');
  }
}

(async () => {
  try {
    await probe('pids', `const cp=require('child_process');let started=0,denied=0;const errors=new Set(),children=[],closed=[],awaits=[];
for(let i=0;i<40;i++){const child=cp.spawn('/bin/sleep',['60'],{stdio:'ignore'});children.push(child);
closed.push(new Promise(r=>child.once('close',r)));awaits.push(new Promise(r=>{child.once('spawn',()=>{started++;r()});child.once('error',e=>{denied++;errors.add(e.code);r()})}))}
Promise.all(awaits).then(async()=>{for(const child of children)if(child.pid)child.kill('SIGKILL');await Promise.all(closed);console.log(JSON.stringify({started,denied,errors:[...errors]}))});`);
    await probe('memory', `const retained=[];for(let i=0;i<512;i++)retained.push(Buffer.alloc(1024*1024,1));console.log('unexpected-unbounded-allocation');`);
  } finally {
    if (!/^flujo-mcp-limits-[A-Za-z0-9]+$/.test(path.relative(parent, workspace))) throw new Error('Unsafe probe cleanup');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(() => { console.error('Controlled MCP resource-limit probe failed'); process.exitCode = 1; });
