'use strict';
// Qualification-only instrumentation: the actual SDK/Undici transport is intact.
// Reject at the native connection boundary, including implicit telemetry/discovery.
function installLoopbackGuard(port) {
  const net = require('node:net');
  const tls = require('node:tls');
  const cp = require('node:child_process');
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function(...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    const options = normalized[0];
    if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(options.host)
        || Number(options.port) !== port) throw new Error('Qualification blocked non-provider connection');
    return original.apply(this, args);
  };
  tls.connect = () => { throw new Error('Qualification blocked TLS connection'); };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[key] = () => { throw new Error('Qualification blocked runtime child process'); };
  }
}
module.exports = { installLoopbackGuard };
