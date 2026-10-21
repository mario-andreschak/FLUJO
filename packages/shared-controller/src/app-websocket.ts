import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { Transform, pipeline, type Duplex } from 'node:stream';
import { appRequestHeaders, appResponseCookies } from './app-headers.js';

const protocolToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function rejectAppUpgrade(socket: Duplex, status = 403): void {
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  const deadline = setTimeout(() => socket.destroy(), 1000); deadline.unref();
  socket.once('close', () => clearTimeout(deadline));
}

/** Browser-origin/session admission happens before this fixed sandbox pipe.
 * No destination, port, owner bearer or exec command comes from the request. */
export function appWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer, options: {
  origin: string; connect: () => Duplex | undefined; current: () => boolean; finished: () => void;
}): void {
  const key = request.headers['sec-websocket-key'];
  const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket'
      || !(request.headers.connection ?? '').toLowerCase().split(',').some(value => value.trim() === 'upgrade')
      || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string'
      || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').toString('base64') !== key
      || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'
      || request.headers['transfer-encoding'] !== undefined || head.length > 64 * 1024
      || protocols.length > 16 || protocols.some(value => value.length > 128 || !protocolToken.test(value))) {
    rejectAppUpgrade(socket, 400); options.finished(); return;
  }
  const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const current = () => { try { return options.current(); } catch { return false; } };
  if (!current()) { rejectAppUpgrade(socket); options.finished(); return; }
  socket.pause();
  let done = false; let upgraded = false;
  let pipe: Duplex | undefined; let peer: Duplex | undefined; let upstream: ClientRequest | undefined;
  let check: ReturnType<typeof setInterval> | undefined; let deadline: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined; let handshake: ReturnType<typeof setTimeout> | undefined;
  const limits: Transform[] = [];
  const finish = (status?: number) => {
    if (done) return;
    done = true;
    clearInterval(check); clearTimeout(deadline); clearTimeout(idle); clearTimeout(handshake);
    upstream?.destroy(); peer?.destroy(); pipe?.destroy();
    limits.forEach(limit => limit.destroy());
    if (status && !upgraded && !socket.destroyed) rejectAppUpgrade(socket, status);
    else socket.destroy();
    options.finished();
  };
  socket.once('close', () => finish()); socket.once('error', () => finish());
  // Both directions stay bounded and apply stream backpressure. A reconnect
  // gets fresh admission; the limit is cumulative, not per attacker-chosen frame.
  const limiter = () => {
    let bytes = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (done || !current() || bytes > 256 * 1024 * 1024) {
        finish(); callback(new Error('App stream admission ended.')); return;
      }
      idle?.refresh(); callback(null, chunk);
    } });
    limit.on('error', () => finish()); limits.push(limit); return limit;
  };
  try {
    pipe = options.connect();
    if (!pipe) throw new Error('Sandbox transport unavailable.');
    const headers = appRequestHeaders(request, options.origin);
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    // Extensions are deliberately not negotiated: raw relay limits must not
    // become compressed-message amplification limits in the browser/runtime.
    upstream = httpRequest({ host: '127.0.0.1', port: 4201, path: request.url, method: 'GET', headers,
      createConnection: () => pipe! });
    upstream.once('error', () => finish(502));
    upstream.once('response', response => { response.destroy(); finish(502); });
    upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      if (done) { upstreamSocket.destroy(); return; }
      peer = upstreamSocket;
      const protocol = response.headers['sec-websocket-protocol'];
      if (!current() || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket'
          || !(response.headers.connection ?? '').toLowerCase().split(',').some(value => value.trim() === 'upgrade')
          || response.headers['sec-websocket-accept'] !== expected || response.headers['sec-websocket-extensions'] !== undefined
          || protocol !== undefined && (typeof protocol !== 'string' || !protocols.includes(protocol))
          || upstreamHead.length > 64 * 1024) { finish(502); return; }
      clearTimeout(handshake); upgraded = true;
      const cookies = appResponseCookies(response.headers['set-cookie']);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expected}\r\n`
        + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '')
        + cookies.map(value => `Set-Cookie: ${value}\r\n`).join('') + '\r\n');
      const send = limiter(); const receive = limiter();
      // write() queues at most the bounded initial heads before piping starts.
      if (head.length) send.write(head);
      if (upstreamHead.length) receive.write(upstreamHead);
      pipeline(socket, send, peer, () => finish());
      pipeline(peer, receive, socket, () => finish());
      socket.resume();
    });
    handshake = setTimeout(() => finish(504), 10_000); handshake.unref();
    check = setInterval(() => { if (!current()) finish(401); }, 1000); check.unref();
    deadline = setTimeout(() => finish(504), 60 * 60_000); deadline.unref();
    idle = setTimeout(() => finish(504), 120_000); idle.unref();
    upstream.end();
  } catch { finish(503); }
}
