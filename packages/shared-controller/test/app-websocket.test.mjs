import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { appWebSocket } from '../dist/app-websocket.js';

const origin = `https://app${'a'.repeat(60)}.alice.localhost:4280`;
const key = Buffer.alloc(16, 1).toString('base64');
const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
async function listen(server, t) {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { sockets.forEach(socket => socket.destroy()); server.close(resolve); }));
  return server.address().port;
}
function connect(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/ide/session/socket', headers: {
      origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key,
      'sec-websocket-protocol': 'editor', 'sec-websocket-extensions': 'permessage-deflate',
      cookie: '__Host-flujo-app=private; editor=app', ...headers,
    } });
    request.once('upgrade', (response, socket, head) => { socket.on('error', () => {}); resolve({ response, socket, head }); });
    request.once('response', response => { response.resume(); resolve({ response }); });
    request.once('error', reject); request.end();
  });
}

test('real upgrade relays frames and closes both peers on parent revocation', { timeout: 15_000 }, async t => {
  let observed; let targetSocket; let current = true; let finished = 0;
  const target = createServer(); target.on('upgrade', (request, socket) => {
    observed = request.headers; targetSocket = socket;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: editor\r\nSet-Cookie: __Host-flujo-app=forged; Secure; Path=/\r\n\r\n`);
    socket.on('data', chunk => socket.write(chunk));
  });
  const back = await listen(target, t);
  const controller = createServer(); controller.on('upgrade', (request, socket, head) => appWebSocket(request, socket, head, {
    origin, connect: () => createConnection({ host: '127.0.0.1', port: back }), current: () => current, finished: () => { finished++; },
  }));
  const front = await listen(controller, t);
  const client = await connect(front);
  assert.equal(client.response.statusCode, 101);
  assert.equal(observed.host, new URL(origin).host);
  assert.equal(observed.cookie, 'editor=app');
  assert.equal(observed['sec-websocket-extensions'], undefined);
  assert.equal(observed.authorization, undefined);
  assert.equal(client.response.headers['set-cookie'], undefined);
  const frame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
  const echoed = once(client.socket, 'data'); client.socket.write(frame);
  assert.deepEqual((await echoed)[0], frame);
  const browserClosed = new Promise(resolve => client.socket.once('close', resolve));
  const targetClosed = new Promise(resolve => targetSocket.once('close', resolve));
  current = false;
  await Promise.all([browserClosed, targetClosed]);
  assert.equal(finished, 1);
});

test('invalid upgrades and unapproved server negotiation fail without exposing sidecar headers', async t => {
  let contacts = 0; let invalid = false; let mode = 'extensions';
  const target = createServer(); target.on('upgrade', (_request, socket) => {
    contacts++;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${mode === 'accept' ? 'invalid' : accept}\r\n`
      + (mode === 'extensions' ? 'Sec-WebSocket-Extensions: permessage-deflate\r\n' : '')
      + (mode === 'protocol' ? 'Sec-WebSocket-Protocol: unrequested\r\n' : '') + '\r\n');
  });
  const back = await listen(target, t);
  const controller = createServer(); controller.on('upgrade', (request, socket, head) => appWebSocket(request, socket, head, {
    origin, connect: () => { if (invalid) throw new Error('private daemon diagnostic'); return createConnection({ host: '127.0.0.1', port: back }); },
    current: () => true, finished: () => {},
  }));
  const front = await listen(controller, t);
  assert.equal((await connect(front, { 'sec-websocket-key': 'invalid' })).response.statusCode, 400);
  assert.equal(contacts, 0);
  for (mode of ['extensions', 'accept', 'protocol']) assert.equal((await connect(front)).response.statusCode, 502);
  invalid = true;
  assert.equal((await connect(front)).response.statusCode, 503);
  assert.equal(contacts, 3);
});
