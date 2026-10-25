'use strict';
// Separate process: bounded deterministic HTTP endpoint, never a paid provider.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILE, hash } = require('./profile.cjs');
const { TERMINAL_MARKER, TERMINAL_CODE, RETRY_MARKER, completionMarker } = require('./checks.cjs');
const MODEL_NAMES = ['parent', ...Array.from({ length: 8 }, (_, i) => 'child-' + i), 'retry-control', 'live-control', 'pause-control',
  'approval-control', 'effect-control', 'retry-resume'];
function createProvider(token) {
  let active = 0, peakActive = 0, rejected = 0, totalRequests = 0, batch = 0;
  const counts = Object.fromEntries(MODEL_NAMES.map(name => [name, 0]));
  const lifetimeCounts = Object.fromEntries(MODEL_NAMES.map(name => [name, 0]));
  const emptyOutcome = () => ({ success: 0, retry429: 0, permanent400: 0, terminalMarker: '', retryMarker: '', completionMarker: '' });
  const outcomes = Object.fromEntries(MODEL_NAMES.map(name => [name, emptyOutcome()]));
  const sockets = new Set();
  const held = new Set();
  const receipt = () => ({ batch, active, held: held.size, peakActive, rejected, totalRequests, counts: { ...counts },
    outcomes: Object.fromEntries(MODEL_NAMES.map(name => [name, { ...outcomes[name] }])), memory: process.memoryUsage() });
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(403).end(); return; }
    if (request.url === '/control/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(receipt())); return; }
    if (request.url === '/control/release') { for (const release of held) release(); response.end('released'); return; }
    if (request.url === '/control/next-batch' && request.method === 'POST') {
      if (active) { response.writeHead(409).end(); return; }
      batch++; for (const name of MODEL_NAMES) { counts[name] = 0; outcomes[name] = emptyOutcome(); }
      response.end(JSON.stringify(receipt())); return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
    if (active >= PROFILE.provider.maxActive) { rejected++; response.writeHead(503).end(); request.resume(); return; }
    active++; peakActive = Math.max(peakActive, active);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > PROFILE.provider.maxBodyBytes) throw new Error('provider_body_limit');
        chunks.push(chunk);
      }
      let body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      const model = body.model, stream = body.stream === true;
      if (!MODEL_NAMES.includes(model)) throw new Error('unexpected_model');
      // Release request payloads before delayed responses; counters have a fixed key set.
      body = undefined; chunks.length = 0;
      counts[model]++; lifetimeCounts[model]++; totalRequests++;
      if (model === 'live-control') await new Promise(resolve => {
        // Only the authenticated control or shutdown releases this request.
        // The independent supervisor bounds a failed control; time is not a successful release.
        function release() { held.delete(release); resolve(); }
        held.add(release);
      });
      if ((model === 'child-4' || model === 'retry-control') && counts[model] === 1) {
        outcomes[model].retry429++; outcomes[model].retryMarker = RETRY_MARKER;
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '1' });
        response.end(JSON.stringify({ error: { message: RETRY_MARKER } })); return;
      }
      if (model === 'child-3' || (model === 'retry-resume' && counts[model] === 1)) {
        outcomes[model].permanent400++; outcomes[model].terminalMarker = TERMINAL_MARKER;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: TERMINAL_MARKER, code: TERMINAL_CODE } })); return;
      }
      const content = completionMarker(model, batch);
      outcomes[model].success++; outcomes[model].completionMarker = content;
      const approval = model === 'approval-control' && lifetimeCounts[model] === 1;
      const toolCalls = [{ id: 'qualification-approval-call', type: 'function',
        function: { name: 'qualification_write', arguments: '{}' } }];
      if (stream) {
        response.setHeader('content-type', 'text/event-stream');
        const item = { id: 'local-' + batch, object: 'chat.completion.chunk', created: 1, model,
          choices: [{ index: 0, delta: approval ? { role: 'assistant', tool_calls: toolCalls.map(call => ({ index: 0, ...call })) }
            : { role: 'assistant', content }, finish_reason: null }] };
        response.end('data: ' + JSON.stringify(item) + '\n\ndata: ' + JSON.stringify({ ...item,
          choices: [{ index: 0, delta: {}, finish_reason: approval ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'local-' + batch, object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, finish_reason: approval ? 'tool_calls' : 'stop', message: approval
            ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    } catch (error) { if (!response.headersSent) response.writeHead(413); response.end(String(error.message).slice(0, 256)); }
    finally { active--; }
  });
  server.maxConnections = PROFILE.provider.maxSockets;
  server.requestTimeout = PROFILE.provider.requestTimeoutMs;
  server.headersTimeout = PROFILE.provider.requestTimeoutMs;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return { server, receipt, close: async () => {
    for (const release of held) release();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
async function main(output) {
  const contract = JSON.parse(fs.readFileSync(path.join(output, 'contract.json'), 'utf8'));
  const provider = createProvider(contract.token);
  await new Promise(resolve => provider.server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(output, 'provider-ready.json'), JSON.stringify({
    pid: process.pid, origin: 'http://127.0.0.1:' + provider.server.address().port,
    tokenSha256: hash(contract.token),
  }), { flag: 'wx' });
  const timer = setInterval(() => {
    if (process.memoryUsage().rss > PROFILE.budgets.providerRss) { console.error('provider_rss_limit'); process.exitCode = 1; stop(); }
    if (fs.existsSync(path.join(output, 'stop-provider'))) stop();
  }, 1000);
  let stopped = false;
  async function stop() {
    if (stopped) return; stopped = true; clearInterval(timer);
    await provider.close();
    fs.writeFileSync(path.join(output, 'provider-settled.json'), JSON.stringify(provider.receipt()), { flag: 'wx' });
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { createProvider, MODEL_NAMES };
