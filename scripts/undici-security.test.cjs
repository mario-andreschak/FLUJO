const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const roots = ['undici', 'mcp-remote/node_modules/undici'];

if (process.argv[2] === '--encoding-child') {
  const { fetch } = require(process.argv[3]);
  fetch(process.argv[4]).then(response => response.text()).then(
    () => { process.exitCode = 2; },
    () => { /* Malformed response must fail this request, while the process lives. */ },
  ).finally(() => setTimeout(() => {}, 100));
} else {
  for (const name of roots) {
    const resolver = name === 'undici' ? requireFromRoot
      : createRequire(path.join(root, 'node_modules/mcp-remote/package.json'));
    const modulePath = resolver.resolve('undici');
    const { Agent, Pool, fetch } = require(modulePath);
    const version = require(path.join(path.dirname(modulePath), 'package.json')).version;
    test(`${name}@${version} preserves TLS identity callbacks passed to origin dispatchers`, async () => {
      const verify = () => new Error('Fixture certificate pin refusal');
      let observed;
      const agent = new Agent({ tls: { checkServerIdentity: verify }, factory(origin, options) {
        observed = options.tls?.checkServerIdentity;
        return new Pool(origin, options);
      } });
      const server = createServer((_request, response) => response.end('local'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher: agent });
        await response.text();
        assert.equal(observed, verify, 'Agent must not drop the caller TLS verification function');
      } finally { await agent.close(); await new Promise(resolve => server.close(resolve)); }
    });
    test(`${name}@${version} refuses a mismatched mixed-case integrity digest`, async () => {
      const server = createServer((_request, response) => response.end('actual fixture bytes'));
      const agent = new Agent();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const integrity = 'SHA256-' + createHash('sha256').update('different bytes').digest('base64');
        await assert.rejects(async () => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}`, { dispatcher: agent, integrity });
          await response.text();
        }, /integrity|fetch failed/i);
      } finally { await agent.close(); await new Promise(resolve => server.close(resolve)); }
    });
    test(`${name}@${version} rejects excessive encodings without terminating the process`, async () => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip' });
        response.end();
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        await promisify(execFile)(process.execPath,
          [__filename, '--encoding-child', modulePath, `http://127.0.0.1:${server.address().port}`],
          { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
      } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
    });
  }
}

