import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CONTROLLED_PUBLIC_FIXTURE_MANIFEST, validatePublicFixtureManifest } from './public-fixture-manifest.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function readJsonLines(filename) {
  try {
    return (await fs.readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function atomicJson(filename, value) {
  const temporary = filename + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temporary, filename);
}

async function readBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request payload exceeds the approved limit.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function verifiedContent(content, facts) {
  return typeof content === 'string' && content.length >= 80
    && [facts.sourceId, facts.audience, facts.benefit].every(value => content.includes(value));
}

export async function startPublicFixtureServer({
  verifierRoot,
  agentRoot,
  runId,
  token,
  manifest = CONTROLLED_PUBLIC_FIXTURE_MANIFEST,
  acknowledgementHoldMs = 300_000,
}) {
  validatePublicFixtureManifest(manifest);
  if (!runId || !token) throw new Error('runId and an ephemeral fixture token are required.');
  const resolvedVerifierRoot = path.resolve(verifierRoot);
  const resolvedAgentRoot = path.resolve(agentRoot);
  await Promise.all([
    fs.mkdir(resolvedVerifierRoot, { recursive: true }),
    fs.mkdir(resolvedAgentRoot, { recursive: true }),
  ]);
  if ((await fs.readdir(resolvedVerifierRoot)).length) {
    throw new Error('Trusted verifier root must be empty.');
  }
  const nonce = randomBytes(8).toString('hex');
  const facts = {
    product: 'FLUJO',
    sourceId: 'endurance-research-' + nonce,
    audience: 'independent automation teams ' + nonce,
    benefit: 'sustain verified marketing progress across failures ' + nonce,
    channel: 'controlled-developer-community',
    nonce,
  };
  const statePath = path.join(resolvedVerifierRoot, 'state.json');
  const auditPath = path.join(resolvedVerifierRoot, 'audit.jsonl');
  const manifestPath = path.join(resolvedVerifierRoot, 'manifest.json');
  const state = {
    schemaVersion: 1,
    runId,
    serviceId: manifest.id,
    manifestVersion: manifest.version,
    tokenSha256: sha256(token),
    createdAt: Date.now(),
    facts,
    artifacts: {},
    publicationAttempts: 0,
    effects: [],
    acknowledgementState: 'not_started',
    cleanup: { required: true, status: 'pending' },
  };
  await Promise.all([
    atomicJson(statePath, state),
    fs.writeFile(auditPath, ''),
    fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n'),
  ]);

  let auditSequence = 0;
  let auditWrite = Promise.resolve();
  let stateWrite = Promise.resolve();
  let requestTimestamps = [];
  const appendAudit = async (type, details = {}) => {
    const event = { sequence: ++auditSequence, at: Date.now(), type, ...details };
    auditWrite = auditWrite.then(() => fs.appendFile(auditPath, JSON.stringify(event) + '\n'));
    await auditWrite;
    return event;
  };
  const saveState = () => {
    const snapshot = structuredClone(state);
    stateWrite = stateWrite.then(() => atomicJson(statePath, snapshot));
    return stateWrite;
  };
  const authenticate = request => request.headers.authorization === 'Bearer ' + token;
  const sendJson = (response, status, value, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    response.end(JSON.stringify(value));
  };
  const loadArtifacts = async () => {
    const artifacts = {};
    for (const name of ['research.md', 'launch.md', 'backlog.md']) {
      try {
        const content = await fs.readFile(path.join(resolvedAgentRoot, name), 'utf8');
        artifacts[name] = {
          name,
          content,
          sha256: sha256(content),
          verified: verifiedContent(content, facts),
        };
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return artifacts;
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requestIdentity = {
      method: request.method,
      path: url.pathname,
      userAgent: String(request.headers['user-agent'] ?? ''),
      idempotencyKey: String(request.headers['idempotency-key'] ?? ''),
    };
    try {
      if (url.pathname === '/health') {
        sendJson(response, 200, { ready: true, serviceId: manifest.id, runId });
        return;
      }
      const requestAt = Date.now();
      requestTimestamps = requestTimestamps.filter(value => value > requestAt - 60_000);
      if (requestTimestamps.length >= manifest.limits.maxRequestsPerMinute) {
        await appendAudit('request_rate_limited', requestIdentity);
        sendJson(response, 429, { error: 'Approved request-rate limit exhausted.' }, {
          'Retry-After': '60',
        });
        return;
      }
      requestTimestamps.push(requestAt);
      if (url.pathname === '/research' && request.method === 'GET') {
        await appendAudit('research_read', requestIdentity);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><title>FLUJO endurance research</title><main>'
          + '<h1>FLUJO campaign evidence</h1><p>Source: ' + facts.sourceId + '</p>'
          + '<p>Audience: ' + facts.audience + '</p><p>Benefit: ' + facts.benefit + '</p>'
          + '<p>Channel: ' + facts.channel + '</p></main>'
          + '<script>fetch("/browser-observed",{method:"POST",headers:{"Content-Type":"application/json"},'
          + 'body:JSON.stringify({sourceId:' + JSON.stringify(facts.sourceId)
          + ',rendered:document.querySelector("main").innerText})})</script></html>');
        return;
      }
      if (url.pathname === '/browser-observed' && request.method === 'POST') {
        const body = await readBody(request, manifest.limits.maxPayloadBytes);
        await appendAudit('browser_observed', { ...requestIdentity, sourceId: body.sourceId, renderedSha256: sha256(String(body.rendered ?? '')) });
        sendJson(response, 200, { observed: true });
        return;
      }
      if (!authenticate(request)) {
        await appendAudit('authorization_rejected', requestIdentity);
        sendJson(response, 401, { error: 'Controlled-service authorization is required.' });
        return;
      }
      if (url.pathname === '/research.json' && request.method === 'GET') {
        await appendAudit('research_read', requestIdentity);
        sendJson(response, 200, { serviceId: manifest.id, runId, facts });
        return;
      }
      if (url.pathname === '/artifact-observation' && request.method === 'POST') {
        const body = await readBody(request, manifest.limits.maxPayloadBytes);
        if (!['research.md', 'launch.md', 'backlog.md'].includes(body.name)
          || !verifiedContent(body.content, facts)
          || sha256(body.content) !== body.sha256) {
          sendJson(response, 422, { error: 'Artifact does not match the run-specific research facts and hash.' });
          return;
        }
        const observed = {
          name: body.name,
          sha256: body.sha256,
          observedAt: Date.now(),
          verified: true,
        };
        state.artifacts[body.name] = observed;
        await saveState();
        await appendAudit('artifact_verified', { ...requestIdentity, artifact: observed });
        sendJson(response, 200, observed);
        return;
      }
      if (url.pathname === '/publication' && request.method === 'GET') {
        const effect = state.effects[0] ?? null;
        if (effect && state.acknowledgementState === 'withheld_after_commit') {
          state.acknowledgementState = 'reconciled';
          await saveState();
          await appendAudit('publication_uncertain_effect_reconciled', { ...requestIdentity, publicationId: effect.id });
        }
        await appendAudit('publication_readback', { ...requestIdentity, publicationId: effect?.id ?? null });
        sendJson(response, 200, { publication: effect, cleanup: state.cleanup });
        return;
      }
      if (url.pathname === '/evidence' && request.method === 'GET') {
        await Promise.all([stateWrite, auditWrite]);
        sendJson(response, 200, { state, audit: await readJsonLines(auditPath) });
        return;
      }
      if (url.pathname === '/publish' && request.method === 'POST') {
        const idempotencyKey = requestIdentity.idempotencyKey;
        if (!idempotencyKey) {
          sendJson(response, 400, { error: 'Idempotency-Key is required.' });
          return;
        }
        if (state.publicationAttempts >= manifest.limits.maxAttempts) {
          sendJson(response, 429, { error: 'Approved attempt limit exhausted.' });
          return;
        }
        state.publicationAttempts += 1;
        const artifacts = await loadArtifacts();
        for (const artifact of Object.values(artifacts)) {
          if (artifact.verified && !state.artifacts[artifact.name]) {
            state.artifacts[artifact.name] = {
              name: artifact.name,
              sha256: artifact.sha256,
              observedAt: Date.now(),
              verified: true,
            };
          }
        }
        if (!artifacts['research.md']?.verified || !artifacts['launch.md']?.verified) {
          await saveState();
          await appendAudit('publication_rejected', { ...requestIdentity, reason: 'missing_verified_artifacts' });
          sendJson(response, 422, { error: 'Verified research.md and launch.md are required.' });
          return;
        }
        const existing = state.effects[0];
        if (existing) {
          if (existing.idempotencyKey !== idempotencyKey) {
            await appendAudit('duplicate_effect_prevented', { ...requestIdentity, existingPublicationId: existing.id });
            sendJson(response, 409, { error: 'A publication already exists under another key.', publication: existing });
            return;
          }
          state.acknowledgementState = 'reconciled';
          await saveState();
          await appendAudit('publication_idempotent_readback', { ...requestIdentity, publicationId: existing.id });
          sendJson(response, 200, { publication: existing, replayed: true });
          return;
        }
        if (state.publicationAttempts === 1) {
          state.acknowledgementState = 'rate_limited';
          await saveState();
          await appendAudit('publication_rate_limited', requestIdentity);
          sendJson(response, 429, { error: 'Temporary rate limit.', retryable: true, retryAfterMs: 1_000 }, { 'Retry-After': '1' });
          return;
        }
        const effect = {
          id: 'controlled-publication-' + facts.nonce,
          serviceId: manifest.id,
          idempotencyKey,
          sourceId: facts.sourceId,
          contentSha256: artifacts['launch.md'].sha256,
          publishedAt: Date.now(),
          readbackUrl: '/publication',
        };
        state.effects.push(effect);
        state.acknowledgementState = 'withheld_after_commit';
        await saveState();
        await appendAudit('publication_committed_ack_withheld', { ...requestIdentity, publicationId: effect.id, contentSha256: effect.contentSha256 });
        const hold = setTimeout(() => {
          if (!response.writableEnded) response.destroy();
        }, acknowledgementHoldMs);
        hold.unref();
        response.once('close', async () => {
          clearTimeout(hold);
          if (state.acknowledgementState === 'withheld_after_commit') {
            state.acknowledgementDroppedAt = Date.now();
            await appendAudit('publication_acknowledgement_dropped', { publicationId: effect.id }).catch(() => undefined);
          }
        });
        return;
      }
      if (url.pathname === '/publication' && request.method === 'DELETE') {
        const effect = state.effects[0] ?? null;
        state.cleanup = {
          required: true,
          status: 'completed',
          publicationId: effect?.id ?? null,
          completedAt: Date.now(),
        };
        await saveState();
        await appendAudit('publication_cleanup_completed', { ...requestIdentity, publicationId: effect?.id ?? null });
        sendJson(response, 200, { cleanup: state.cleanup });
        return;
      }
      sendJson(response, 404, { error: 'Unknown controlled-service operation.' });
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      await appendAudit('request_failed', { ...requestIdentity, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      if (!response.headersSent) sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Controlled fixture did not allocate a TCP port.');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  await appendAudit('fixture_started', { baseUrl, manifestId: manifest.id, manifestVersion: manifest.version });

  return {
    baseUrl,
    verifierRoot: resolvedVerifierRoot,
    agentRoot: resolvedAgentRoot,
    statePath,
    auditPath,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    async readEvidence() {
      await Promise.all([stateWrite, auditWrite]);
      return {
        state: JSON.parse(await fs.readFile(statePath, 'utf8')),
        audit: await readJsonLines(auditPath),
      };
    },
    async cleanup() {
      if (state.cleanup.status !== 'completed') {
        state.cleanup = { required: true, status: 'completed', publicationId: state.effects[0]?.id ?? null, completedAt: Date.now() };
        await saveState();
        await appendAudit('publication_cleanup_completed', { publicationId: state.effects[0]?.id ?? null, initiatedBy: 'runner' });
      }
      return state.cleanup;
    },
  };
}
