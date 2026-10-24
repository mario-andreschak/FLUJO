import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { ModelChannel, hostModelFrame, type RuntimeModelFrame } from './model-channel.js';
import { MODEL_BODY_BYTES, MODEL_LIFETIME_MS } from './model-grant.js';

interface Pending { response: ServerResponse; timer: ReturnType<typeof setTimeout>; sequence: number; writing: boolean; headers: boolean; }

/** Inside one networkless owner only. There is no host address/credential here;
 * even a forged helper request is re-authorized on the host's fixed owner pipe. */
export function createRuntimeModelServer(input: Readable, output: Writable) {
  const pending = new Map<string, Pending>(); let stopped = false; let active = 0; let heartbeat = performance.now();
  const finish = () => {
    if (stopped) return; stopped = true;
    clearInterval(watch); server.close(); server.closeAllConnections();
    for (const value of pending.values()) { clearTimeout(value.timer); value.response.destroy(); }
    pending.clear(); channel.close();
  };
  const send = (value: RuntimeModelFrame) => channel.send(value).catch(finish);
  const channel = new ModelChannel(input, output, raw => {
    const frame = hostModelFrame.parse(raw);
    if (frame.type === 'ping') { heartbeat = performance.now(); void send({ type: 'pong' }); return; }
    const item = pending.get(frame.id);
    // Late replies after cancellation are harmless. They cannot find a new
    // request because identifiers are random and never reused by this process.
    if (!item) return;
    if (frame.type === 'headers') {
      if (item.headers) throw new Error('Duplicate model headers.');
      item.headers = true;
      item.response.writeHead(200, { 'Content-Type': frame.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      item.response.flushHeaders();
    } else if (frame.type === 'chunk') {
      if (!item.headers || item.writing || frame.sequence !== item.sequence++) throw new Error('Invalid response credit.');
      item.writing = true;
      const ack = () => { item.writing = false; if (pending.has(frame.id)) void send({ type: 'ack', id: frame.id, sequence: frame.sequence }); };
      if (item.response.write(Buffer.from(frame.bytes, 'base64'))) ack(); else item.response.once('drain', ack);
    } else if (frame.type === 'end') {
      if (!item.headers || item.writing) throw new Error('Incomplete model response.');
      pending.delete(frame.id); clearTimeout(item.timer); item.response.end();
    } else {
      pending.delete(frame.id); clearTimeout(item.timer);
      if (item.headers) item.response.destroy();
      else {
        const status = { unavailable: 503, denied: 403, invalid_request: 400, busy: 429 }[frame.code];
        item.response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        item.response.end(JSON.stringify({ error: { message: 'Local model request unavailable.', code: frame.code } }));
      }
    }
  }, finish);
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 }, async (request, response) => {
    const match = /^\/grants\/([a-zA-Z0-9_-]{1,64})\/v1\/(models|chat\/completions|embeddings)$/.exec(request.url ?? '');
    const team = /^\/teams\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})\/revisions\/([1-9][0-9]{0,14})\/(?:grants\/([a-f0-9]{64})\/)?v1\/(configuration|models|chat\/completions|embeddings)$/.exec(request.url ?? '');
    const catalogue = /^\/teams\/models(?:\/after\/([A-Za-z0-9_-]{43}))?$/.exec(request.url ?? '');
    const resolve = /^\/teams\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})\/current$/.exec(request.url ?? '');
    const path = match?.[2] ?? team?.[5] ?? ((catalogue || resolve) ? 'configuration' : undefined);
    const operation = path === 'chat/completions' ? 'chat' : path;
    const reading = operation === 'models' || operation === 'configuration';
    const deny = (status: number) => {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'Connection': 'close', 'Cache-Control': 'no-store' }); response.end();
    };
    if (stopped || performance.now() - heartbeat > 10_000) { deny(503); return; }
    if ((!match && !team && !catalogue && !resolve) || !operation || !['configuration', 'models', 'chat', 'embeddings'].includes(operation)
        || request.method !== (reading ? 'GET' : 'POST') || request.headers.origin
        || (!reading && request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) { deny(400); return; }
    if (active >= 4) { deny(429); return; }
    active++; let released = false;
    response.once('close', () => { if (!released) { released = true; active--; } });
    const id = randomBytes(16).toString('hex');
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length; if (bytes > MODEL_BODY_BYTES || (reading && bytes)) { deny(413); return; }
        chunks.push(chunk);
      }
      if (response.destroyed || stopped) return;
      const body = reading ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const cancel = () => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id); clearTimeout(item.timer); void send({ type: 'cancel', id });
      };
      pending.set(id, { response, timer: setTimeout(() => { cancel(); response.destroy(); }, MODEL_LIFETIME_MS), sequence: 0, writing: false, headers: false });
      response.once('close', cancel);
      const payload = body === undefined ? {} : { body };
      if (catalogue) await send({ type: 'team-catalogue', id, ...(catalogue[1] ? { after: catalogue[1] } : {}) });
      else if (resolve) await send({ type: 'team-resolve', id, teamId: resolve[1], resourceId: resolve[2] });
      else if (team) await send({ type: 'team-request', id, teamId: team[1], resourceId: team[2], version: Number(team[3]),
        ...(team[4] ? { generation: team[4] } : {}), operation: operation as 'configuration' | 'models' | 'chat' | 'embeddings', ...payload });
      else await send({ type: 'request', id, grant: match![1], operation: operation as 'models' | 'chat' | 'embeddings', ...payload });
    } catch { if (!response.headersSent) deny(400); else response.destroy(); }
  });
  server.on('error', finish);
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.maxConnections = 16;
  const watch = setInterval(() => { if (performance.now() - heartbeat > 10_000) finish(); }, 1000);
  server.once('listening', () => { void send({ type: 'ready' }); });
  return { server, close: finish };
}
