'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('./profile.cjs');
const { MODEL_NAMES, ownedProviderConfig, projectProviderStatus, boundedControlBody, createProviderControl } = require('./provider-control.cjs');
const token = 'a'.repeat(48);
const environment = () => ({ FLUJO_569_PROVIDER_TOKEN: token, FLUJO_569_PROVIDER_PORT: '12345', FLUJO_569_PROVIDER_PID: '321' });
const ready = () => ({ pid: 321, origin: 'http://127.0.0.1:12345', tokenSha256: hash(token) });
function status() {
  return { batch: 1, active: 0, held: 0, peakActive: 4, rejected: 0, totalRequests: 0,
    counts: Object.fromEntries(MODEL_NAMES.map(name => [name, 0])),
    outcomes: Object.fromEntries(MODEL_NAMES.map(name => [name, { success: 0, retry429: 0, permanent400: 0, terminalMarker: '', retryMarker: '', completionMarker: '' }])),
    memory: { rss: 1000, heapTotal: 500, heapUsed: 400, external: 200, arrayBuffers: 100 } };
}
test('provider config binds exact supervisor PID/token/origin and removes inherited credentials', () => {
  const env = environment(); const config = ownedProviderConfig({ token }, ready(), env);
  assert.deepEqual(config, { token, port: 12345, origin: 'http://127.0.0.1:12345' }); assert.deepEqual(env, {});
  for (const origin of ['http://localhost:12345', 'https://127.0.0.1:12345', 'http://user@127.0.0.1:12345',
    'http://127.0.0.1:12345/path', 'http://127.0.0.1:12345?q=x', 'http://127.0.0.1:12345#x', 'http://example.com:12345']) {
    assert.throws(() => ownedProviderConfig({ token }, { ...ready(), origin }, environment()));
  }
  for (const port of ['0', '65536', '0123', '12345/path']) assert.throws(() => ownedProviderConfig({ token }, ready(), { ...environment(), FLUJO_569_PROVIDER_PORT: port }));
  assert.throws(() => ownedProviderConfig({ token }, { ...ready(), pid: 322 }, environment()), /PID/);
  assert.throws(() => ownedProviderConfig({ token }, { ...ready(), tokenSha256: hash('other') }, environment()), /hash/);
  const changed = environment();
  assert.throws(() => ownedProviderConfig({ token: 'b'.repeat(48) }, ready(), changed), error => {
    assert(!String(error).includes(token)); return true;
  });
  assert.deepEqual(changed, {});
});
test('status projection retains exact counters and known markers but refuses arbitrary response content', () => {
  const value = status(); value.counts['child-4'] = 2;
  value.outcomes['child-4'] = { success: 1, retry429: 1, permanent400: 0, terminalMarker: '', retryMarker: 'deterministic_retry', completionMarker: 'completed child-4 batch 1' };
  assert.deepEqual(projectProviderStatus(value), value);
  assert.notEqual(projectProviderStatus(value).outcomes, value.outcomes);
  for (const change of [v => { v.extra = 'arbitrary'; }, v => { v.counts.extra = 1; }, v => { v.memory = []; },
    v => { v.active = 5; }, v => { v.batch = 195; }, v => { v.totalRequests = Infinity; },
    v => { v.counts.parent = '1'; }, v => { v.counts.parent = -1; }, v => { v.counts.parent = 65; },
    v => { v.outcomes.parent.success = 1; }, v => { v.outcomes.parent.completionMarker = 'untrusted text'; }]) {
    const invalid = status(); change(invalid); assert.throws(() => projectProviderStatus(invalid));
  }
});
test('control response is byte-bounded before JSON parsing and HTTP redirects are prohibited', async () => {
  const config = ownedProviderConfig({ token }, ready(), environment());
  const control = createProviderControl(config, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:12345/control/status'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer ' + token); return new Response(JSON.stringify(status()));
  });
  assert.deepEqual(await control('status'), status());
  await assert.rejects(control('../unexpected'), /action/);
  await assert.rejects(control('status', 'POST'), /action/);
  await assert.rejects(boundedControlBody(new Response('x'.repeat(65537))), /allowance/);
  await assert.rejects(boundedControlBody(new Response(Uint8Array.from([255]))));
  const redirected = createProviderControl(config, async () => ({ status: 200, redirected: true }));
  await assert.rejects(redirected('status'), /redirected/);
  const failed = createProviderControl(config, async () => new Response('failed', { status: 403 }));
  await assert.rejects(failed('status'), /control failed/);
});
