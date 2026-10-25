'use strict';
const assert = require('node:assert/strict');
const { PROFILE, hash } = require('./profile.cjs');
const { TERMINAL_MARKER, RETRY_MARKER, completionMarker } = require('./checks.cjs');
const MODEL_NAMES = ['parent', ...Array.from({ length: 8 }, (_, i) => 'child-' + i), 'retry-control', 'live-control', 'pause-control',
  'approval-control', 'effect-control', 'retry-resume'];
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_BATCH = PROFILE.warmupBatches + Math.ceil(PROFILE.enduranceMs / PROFILE.candidateCadenceMs);

function takeProviderToken(contract, env = process.env) {
  const token = env.FLUJO_569_PROVIDER_TOKEN; delete env.FLUJO_569_PROVIDER_TOKEN;
  assert(typeof token === 'string' && /^[a-f0-9]{48}$/.test(token), 'Missing supervisor-owned provider credential');
  assert(contract.token === token, 'Provider credential does not bind the owned contract');
  return token;
}
function ownedProviderConfig(contract, ready, env = process.env) {
  const portText = env.FLUJO_569_PROVIDER_PORT, pidText = env.FLUJO_569_PROVIDER_PID;
  delete env.FLUJO_569_PROVIDER_PORT; delete env.FLUJO_569_PROVIDER_PID;
  const token = takeProviderToken(contract, env);
  assert(typeof portText === 'string' && /^[1-9][0-9]{0,4}$/.test(portText), 'Invalid owned provider port');
  assert(typeof pidText === 'string' && /^[1-9][0-9]{0,9}$/.test(pidText), 'Invalid owned provider PID');
  const port = Number(portText), pid = Number(pidText);
  assert(port <= 65535 && Number.isSafeInteger(pid));
  const origin = 'http://127.0.0.1:' + port;
  strictKeys(ready, ['pid', 'origin', 'tokenSha256']);
  assert.equal(ready.origin, origin, 'Provider endpoint differs from owned launch');
  assert.equal(ready.pid, pid, 'Provider PID differs from owned launch');
  assert.equal(ready.tokenSha256, hash(token), 'Provider credential hash differs from owned launch');
  return { origin, port, token };
}
function strictKeys(value, keys) {
  assert(value && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain provider record');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected provider fields');
}
function integer(value, maximum) {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'Invalid provider counter');
  return Number(value);
}
function marker(value, expected) {
  assert(value === '' || value === expected, 'Unexpected provider marker');
  return value === '' ? '' : expected;
}
function projectProviderStatus(value) {
  strictKeys(value, ['batch', 'active', 'held', 'peakActive', 'rejected', 'totalRequests', 'counts', 'outcomes', 'memory']);
  const batch = integer(value.batch, MAX_BATCH), maximumRequests = (MAX_BATCH + 1) * 64;
  const result = { batch, active: integer(value.active, PROFILE.provider.maxActive), held: integer(value.held, PROFILE.provider.maxActive),
    peakActive: integer(value.peakActive, PROFILE.provider.maxActive), rejected: integer(value.rejected, maximumRequests),
    totalRequests: integer(value.totalRequests, maximumRequests), counts: {}, outcomes: {}, memory: {} };
  strictKeys(value.counts, MODEL_NAMES); strictKeys(value.outcomes, MODEL_NAMES);
  for (const model of MODEL_NAMES) {
    result.counts[model] = integer(value.counts[model], 64);
    const outcome = value.outcomes[model];
    strictKeys(outcome, ['success', 'retry429', 'permanent400', 'terminalMarker', 'retryMarker', 'completionMarker']);
    result.outcomes[model] = { success: integer(outcome.success, 64), retry429: integer(outcome.retry429, 64),
      permanent400: integer(outcome.permanent400, 64), terminalMarker: marker(outcome.terminalMarker, TERMINAL_MARKER),
      retryMarker: marker(outcome.retryMarker, RETRY_MARKER), completionMarker: marker(outcome.completionMarker, completionMarker(model, batch)) };
    assert(outcome.success + outcome.retry429 + outcome.permanent400 <= result.counts[model], 'Provider outcomes exceed requests');
  }
  const memoryFields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']; strictKeys(value.memory, memoryFields);
  for (const field of memoryFields) result.memory[field] = integer(value.memory[field], Number.MAX_SAFE_INTEGER);
  return result;
}
async function boundedControlBody(response) {
  assert(response.body, 'Provider control body is missing');
  const bytes = Buffer.alloc(MAX_CONTROL_BYTES); let length = 0;
  for await (const chunk of response.body) {
    assert(chunk instanceof Uint8Array && chunk.byteLength <= MAX_CONTROL_BYTES - length, 'Provider control body exceeds allowance');
    bytes.set(chunk, length); length += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
}
function createProviderControl(config, request = fetch) {
  const methods = { status: 'GET', release: 'GET', 'next-batch': 'POST' };
  return async (action, method = 'GET') => {
    assert(Object.hasOwn(methods, action) && method === methods[action], 'Unexpected provider control action');
    const response = await request(config.origin + '/control/' + action, { method, redirect: 'error',
      headers: { authorization: 'Bearer ' + config.token }, signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, 'Provider control failed');
    assert.equal(response.redirected, false, 'Provider control redirected');
    const text = await boundedControlBody(response);
    if (action === 'release') { assert.equal(text, 'released'); return 'released'; }
    return projectProviderStatus(JSON.parse(text));
  };
}
module.exports = { MODEL_NAMES, takeProviderToken, ownedProviderConfig, projectProviderStatus, boundedControlBody, createProviderControl };
