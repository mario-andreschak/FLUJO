'use strict';
// Qualification-only instrumentation: the actual SDK/Undici transport is intact.
// Reject at the native connection boundary, including implicit telemetry/discovery.
function installGuard(bootstrap, port) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { promisify } = require('node:util');
  const net = require('node:net');
  const tls = require('node:tls');
  const cp = require('node:child_process');
  const nativeSpawn = cp.spawn;
  let phase = bootstrap ? 'bootstrap' : 'runtime', allowedPort = bootstrap ? null : port;
  const probes = [], settlements = [];
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const executable = process.platform === 'win32' && systemRoot && path.win32.isAbsolute(systemRoot)
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined;
  const command = `$p=Get-Process -Id ${process.pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`;
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    const options = normalized[0];
    if (allowedPort === null || options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host)
        || Number(options.port) !== allowedPort) throw new Error('Qualification blocked non-provider connection');
    return original.apply(this, args);
  };
  tls.connect = () => { throw new Error('Qualification blocked TLS connection'); };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[key] = () => { throw new Error('Qualification blocked runtime child process'); };
  }
  if (bootstrap) {
    const guardedExecFile = function(file, args, options, callback) {
      assert(phase === 'bootstrap' && executable && typeof file === 'string'
        && path.win32.normalize(file).toLowerCase() === path.win32.normalize(executable).toLowerCase(), 'Qualification blocked non-bootstrap child');
      assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', command], 'Qualification blocked non-own-PID probe');
      assert(options && Object.getPrototypeOf(options) === Object.prototype);
      assert.deepEqual(Object.keys(options).sort(), ['encoding', 'timeout', 'windowsHide']);
      assert(options.encoding === 'utf8' && options.timeout === 10_000 && options.windowsHide === true, 'Qualification blocked probe options');
      assert(typeof callback === 'function' && probes.length < 3 && probes.every(probe => probe.closed), 'Qualification blocked concurrent/excess probe');
      assert(!process.env.FLUJO_569_PROVIDER_TOKEN, 'Provider credential must not be inherited by bootstrap probe');
      const record = { attempt: probes.length + 1, pid: null, closed: false, stdoutEnded: false, stderrEnded: false,
        stdoutBytes: 0, stderrBytes: 0, exitCode: null, signal: null, killed: false };
      probes.push(record);
      // The supervisor first proves an owned private hidden console. Inherit it:
      // windowsHide:true would allocate another conhost; DETACHED PowerShell5.1
      // exits before executing the query. Only this exact validated OS query
      // uses the qualification transport; no new console, unref or breakaway.
      const child = nativeSpawn(executable, ['-NoProfile', '-NonInteractive', '-Command', command],
        { detached: false, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] });
      record.pid = child.pid ?? null;
      const chunks = { stdout: [], stderr: [] }; let failure;
      const stop = error => { if (!failure) { failure = error; child.kill(); } };
      const timer = setTimeout(() => stop(new Error('Native bootstrap probe timed out')), 10_000);
      child.once('error', error => { failure ??= error; });
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          record[stream + 'Bytes'] += chunk.byteLength;
          if (record[stream + 'Bytes'] > (stream === 'stdout' ? 1024 : 4096)) stop(new Error('Native bootstrap probe output exceeded allowance'));
          else chunks[stream].push(chunk);
        });
        child[stream].once('end', () => { record[stream + 'Ended'] = true; });
      }
      settlements.push(new Promise(resolve => child.once('close', (code, signal) => {
        clearTimeout(timer);
        record.closed = true; record.exitCode = code; record.signal = signal; record.killed = child.killed;
        if (code !== 0 || signal !== null) failure ??= new Error('Native bootstrap probe failed');
        try { callback(failure ?? null, Buffer.concat(chunks.stdout).toString('utf8'), Buffer.concat(chunks.stderr).toString('utf8')); }
        finally { resolve(); }
      })));
      return child;
    };
    // runtimeLock captures this custom promisifier during import. It must always
    // call the stateful gate; copying nativeExecFile's custom symbol bypasses it.
    guardedExecFile[promisify.custom] = (file, args, options) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = guardedExecFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      });
      promise.child = child; return promise;
    };
    cp.execFile = guardedExecFile;
  }
  require('node:module').syncBuiltinESMExports();
  return {
    async sealBootstrap() {
      assert.equal(phase, 'bootstrap'); phase = 'sealing';
      let timer;
      try {
        await Promise.race([Promise.all(settlements), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Bootstrap probe did not close')), 2000);
        })]);
      } finally { clearTimeout(timer); }
      assert(process.platform !== 'win32' || probes.length > 0, 'Windows bootstrap did not perform a native birth probe');
      assert(probes.every(probe => probe.closed && probe.exitCode === 0 && probe.signal === null && !probe.killed
        && probe.stdoutEnded && probe.stderrEnded && probe.stdoutBytes <= 1024 && probe.stderrBytes <= 4096), 'Bootstrap probe did not settle cleanly');
      phase = 'sealed';
      return { sealed: true, probes: probes.map(probe => ({ ...probe })) };
    },
    activateProvider(providerPort) {
      assert(phase === 'sealed' && Number.isSafeInteger(providerPort) && providerPort > 0 && providerPort <= 65535,
        'Provider activation requires sealed bootstrap and an owned port');
      allowedPort = providerPort; phase = 'runtime';
    },
  };
}
function installLoopbackGuard(port) { installGuard(false, port); }
function installRuntimeGuard() { return installGuard(true); }
module.exports = { installLoopbackGuard, installRuntimeGuard };
