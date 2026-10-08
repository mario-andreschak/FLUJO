// Manual source conformance probe. Requires an already installed immutable
// Linux image and local daemon; never pulls, builds, or reads user credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const repository = path.resolve(__dirname, '../../..');
const source = path.join(repository, 'src/backend/services/security/isolatedMcp.ts');
require.extensions['.ts'] = (module, filename) => {
  if (filename !== source) throw new Error('Unexpected source module');
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const { createIsolatedMcpLaunch, isolatedMcpPolicyDigest } = require(source);
const [dockerExecutable, daemon, image] = process.argv.slice(2);
const tempRoot = path.resolve(os.tmpdir());
const workspace = fs.mkdtempSync(path.join(tempRoot, 'flujo-mcp-probe-'));
let launch;
let cleanup;
try {
  const grants = path.join(workspace, 'storage/mcp-grants');
  fs.mkdirSync(path.join(grants, 'public'), { recursive: true });
  fs.mkdirSync(path.join(grants, 'private'));
  fs.writeFileSync(path.join(grants, 'public/public.txt'), 'approved fixture');
  fs.writeFileSync(path.join(grants, 'private/private.txt'), 'synthetic private fixture');
  const program = `
    const fs = require('fs'); const net = require('net');
    const denied = fn => { try { fn(); return false; } catch { return true; } };
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const results = {
      grantedRead: fs.readFileSync('/grants/public/public.txt', 'utf8') === 'approved fixture',
      grantWriteDenied: denied(() => fs.writeFileSync('/grants/public/public.txt', 'changed')),
      rootWriteDenied: denied(() => fs.writeFileSync('/flujo-forbidden', 'changed')),
      ungrantedSiblingDenied: denied(() => fs.readFileSync('/grants/public/../private/private.txt')),
      hostSecretAbsent: process.env.HOST_SYNTHETIC_SECRET === undefined,
      grantedEnvironment: process.env.TEST_GRANTED_TOKEN === 'approved fixture token',
      nonRoot: process.getuid() === 65534,
      noCapabilities: /^CapEff:\\s+0+$/m.test(status),
      noNewPrivileges: /^NoNewPrivs:\\s+1$/m.test(status),
      memoryMax: fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(),
      pidsMax: fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(),
      cpuMax: fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim(),
    };
    fs.writeFileSync('/tmp/allowed', 'bounded scratch');
    results.scratchWrite = fs.readFileSync('/tmp/allowed', 'utf8') === 'bounded scratch';
    const socket = net.connect({host:'192.0.2.1',port:80});
    const timeout = setTimeout(() => { socket.destroy(); results.networkDenied = false; console.log(JSON.stringify(results)); },1500);
    socket.once('error', error => { clearTimeout(timeout); results.networkDenied = ['ENETUNREACH','EHOSTUNREACH'].includes(error.code); console.log(JSON.stringify(results)); });
    socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); results.networkDenied = false; console.log(JSON.stringify(results)); });
  `;
  const policy = {
    schemaVersion: 1, kind: 'docker-deny-egress', dockerExecutable, daemon, image,
    command: ['node', '-e', program], environmentNames: ['TEST_GRANTED_TOKEN'],
    mounts: [{ name: 'public', source: 'storage/mcp-grants/public' }],
    memoryMiB: 128, cpus: 0.5, pidsLimit: 32,
  };
  launch = createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspace,
    { TEST_GRANTED_TOKEN: 'approved fixture token', HOST_SYNTHETIC_SECRET: 'not forwarded' });
  const output = execFileSync(launch.command, [...launch.args], {
    env: launch.env, cwd: launch.cwd, windowsHide: true, timeout: 10000,
    encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = JSON.parse(output.trim());
  cleanup = launch.close();
  console.log(JSON.stringify({ sourceProbe: true, image, ...result, cleanup: cleanup.outcome }));
  const booleans = ['grantedRead', 'grantWriteDenied', 'rootWriteDenied', 'ungrantedSiblingDenied',
    'hostSecretAbsent', 'grantedEnvironment', 'nonRoot', 'noCapabilities', 'noNewPrivileges', 'scratchWrite', 'networkDenied'];
  const [quota, period] = result.cpuMax.split(' ').map(Number);
  if (booleans.some(key => result[key] !== true) || result.memoryMax !== '134217728'
      || result.pidsMax !== '32' || quota / period !== 0.5 || cleanup.outcome === 'unknown') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error && error.name === 'McpIsolationError' ? error.message : 'Source isolation probe failed');
  process.exitCode = 1;
} finally {
  if (launch && !cleanup) console.log(JSON.stringify({ cleanup: launch.close().outcome }));
  const relative = path.relative(tempRoot, workspace);
  if (!/^flujo-mcp-probe-[A-Za-z0-9]+$/.test(relative)) throw new Error('Unsafe probe cleanup target');
  fs.rmSync(workspace, { recursive: true, force: true });
}
