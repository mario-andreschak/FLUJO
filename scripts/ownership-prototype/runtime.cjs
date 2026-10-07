'use strict';
// Disposable source prototype. Not an app server, login implementation or OS sandbox.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { authenticateOwnerBearer, ownerHasScopes, ownerPolicySchema, ownerPolicyRevision } = require('./auth-source.cjs');
const { readBoundedFileSync } = require('../read-bounded-file.cjs');

const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const context = new AsyncLocalStorage();
const queues = new Map();
const jobs = new Map();
const streams = new Set();
const scopes = ['control:admin', 'secrets:read']; // Security's current coarse owner profile.
function resolve(request) {
  const filename = path.join(root, 'owner-policy.json');
  try {
    const policy = ownerPolicySchema.parse(JSON.parse(readBoundedFileSync(filename, 65536).toString('utf8')));
    if (policy.ownerId !== manifest.ownerId) return { error: 503 };
    const principal = authenticateOwnerBearer(request, policy);
    if (!principal) return { error: 401 };
    if (!ownerHasScopes(principal, scopes)) return { error: 403 };
    return { principal: Object.freeze({ ...principal, scopes: Object.freeze([...principal.scopes]),
      tenantId: manifest.tenantId, workspaceId: manifest.workspaceId, policyRevision: ownerPolicyRevision(policy) }) };
  } catch { return { error: 503 }; }
}
function owned(id) {
  const principal = context.getStore();
  return !!principal && principal.ownerId === manifest.ownerId && principal.tenantId === manifest.tenantId
    && principal.workspaceId === manifest.workspaceId && manifest.resourceIds.includes(id);
}
function read(id) {
  if (!owned(id)) throw new Error('Prototype ownership refused');
  return JSON.parse(fs.readFileSync(path.join(root, 'db', `${id}.json`), 'utf8'));
}
function answer(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
function current(request, initial) {
  const result = resolve(request);
  return !result.error && result.principal.ownerId === initial.ownerId
    && result.principal.credentialId === initial.credentialId
    && result.principal.policyRevision === initial.policyRevision;
}
async function serialized(id, task) {
  const previous = queues.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(id, next);
  try { return await next; } finally { if (queues.get(id) === next) queues.delete(id); }
}

const server = http.createServer((incoming, response) => {
  const url = new URL(incoming.url, 'http://localhost');
  const request = new Request(url, { method: incoming.method, headers: incoming.headers });
  const authorization = resolve(request);
  if (authorization.error) return answer(response, authorization.error, { error: 'refused' });
  // Client selectors can narrow the server-owned namespace, never establish it.
  const selectors = [url.searchParams.get('workspace'), incoming.headers['x-flujo-workspace']].filter(Boolean);
  if (selectors.some(selected => selected !== manifest.workspaceId)) return answer(response, 404, { error: 'not found' });
  const principal = authorization.principal;
  context.run(principal, async () => {
    try {
      if (url.pathname === '/resources' && incoming.method === 'GET') {
        return answer(response, 200, { ids: [...manifest.resourceIds], actor: context.getStore().ownerId });
      }
      const match = /^\/(resources|background|stream)\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
      if (!match || !owned(match[2])) return answer(response, 404, { error: 'not found' });
      const [, kind, id] = match;
      if (kind === 'resources' && incoming.method === 'GET') return answer(response, 200, read(id));
      if (kind === 'resources' && incoming.method === 'PATCH') {
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 4096) return answer(response, 413, { error: 'too large' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return answer(response, 400, { error: 'invalid body' }); }
        if (!body || Object.keys(body).length !== 1 || typeof body.value !== 'string' || body.value.length > 512) {
          return answer(response, 400, { error: 'invalid body' });
        }
        return serialized(id, async () => {
          if (!current(request, principal)) return answer(response, 401, { error: 'refused' });
          const existing = read(id);
          if (incoming.headers['if-match'] !== String(existing.revision)) return answer(response, 409, { error: 'revision conflict' });
          const next = { ...existing, value: body.value, revision: existing.revision + 1, actor: context.getStore().ownerId };
          const temporary = path.join(root, 'db', `${id}.tmp.${randomUUID()}`);
          fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
          fs.renameSync(temporary, path.join(root, 'db', `${id}.json`));
          return answer(response, 200, next);
        });
      }
      if (kind === 'background' && incoming.method === 'POST') {
        const jobId = randomUUID();
        // Parent IPC releases fixture work deterministically; no user-facing
        // remote resumption route or persistent execution permit is introduced.
        jobs.set(jobId, () => context.run(principal, () => {
          const valid = current(request, principal);
          const result = { jobId, actor: context.getStore().ownerId, tenantId: context.getStore().tenantId,
            workspaceId: context.getStore().workspaceId, status: valid ? 'observed' : 'revoked',
            ...(valid ? { resourceRevision: read(id).revision } : {}) };
          fs.writeFileSync(path.join(root, `${jobId}.result.json`), JSON.stringify(result), { mode: 0o600 });
          process.send({ type: 'job-result', result });
        }));
        return answer(response, 202, { jobId });
      }
      if (kind === 'stream' && incoming.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        let timer;
        const stream = {
          pause() { clearInterval(timer); },
          resume() {
            clearInterval(timer);
            if (!emit()) return false;
            timer = setInterval(emit, 25);
            return true;
          },
        };
        const emit = AsyncLocalStorage.bind(() => {
          if (!current(request, principal)) { stream.pause(); streams.delete(stream); response.end(); return false; }
          response.write(`data: ${JSON.stringify({ actor: context.getStore().ownerId,
            tenantId: context.getStore().tenantId, workspaceId: context.getStore().workspaceId })}\n\n`);
          return true;
        });
        streams.add(stream);
        response.on('close', () => { stream.pause(); streams.delete(stream); });
        stream.resume(); return;
      }
      return answer(response, 405, { error: 'unsupported prototype operation' });
    } catch { answer(response, 503, { error: 'prototype unavailable' }); }
  });
});
process.on('message', message => {
  // Parent-only fixture barriers pause emissions, never authority checks.
  // Resumption rechecks the real policy before emitting or acknowledging.
  if (message?.type === 'pause-streams') {
    for (const stream of streams) stream.pause();
    process.send({ type: 'streams-paused', count: streams.size });
  }
  if (message?.type === 'resume-streams') {
    let count = 0;
    for (const stream of streams) if (stream.resume()) count++;
    process.send({ type: 'streams-resumed', count });
  }
  if (message?.type === 'release') {
    const task = jobs.get(message.jobId);
    jobs.delete(message.jobId);
    if (task) task();
  }
  if (message?.type === 'stop') {
    server.closeAllConnections(); server.close(() => process.exit(0));
  }
});
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port, ownerId: manifest.ownerId }));
