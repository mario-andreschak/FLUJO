import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createJourneyEnvironment } from './environment.mjs';

const applicationRoot = process.env.PERSONA_JOURNEY_APP_DIR ?? process.cwd();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('an occupied port receives no fixture requests and its listener survives', { timeout: 120_000 }, async () => {
  let requests = 0;
  const unrelated = http.createServer((_request, response) => {
    requests += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  await listen(unrelated);
  const port = unrelated.address().port;
  try {
    await assert.rejects(createJourneyEnvironment({ applicationRoot, port }), /Journey server exited/);
    assert.equal(requests, 0, 'No readiness probe or fixture mutation may reach an unrelated listener.');
    assert.equal(unrelated.listening, true);
  } finally {
    await close(unrelated);
  }
});

test('the owned production server initializes, restarts gracefully and retains its isolated data', { timeout: 180_000 }, async () => {
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const environment = await createJourneyEnvironment({ applicationRoot, port });
  try {
    const model = await environment.request('/api/model/journey-model');
    assert.equal(model.baseUrl, `${environment.fixture.url}/v1`);
    assert.deepEqual(await environment.request('/v1/personas'), []);
    await environment.restart();
    assert.equal(environment.epochs.length, 2);
    assert.ok(environment.epochs[0].exitedAt);
    assert.ok([0, 143].includes(environment.epochs[0].exitCode));
    assert.notEqual(environment.epochs[0].pid, environment.epochs[1].pid);
    assert.equal((await environment.request('/api/model/journey-model')).baseUrl, model.baseUrl);
    assert.deepEqual(await environment.request('/v1/personas', undefined, 'journey-isolation'), []);
  } finally {
    await environment.close();
  }
  assert.ok(environment.epochs.every(epoch => epoch.exitedAt));
  await assert.rejects(fetch(environment.baseURL, { signal: AbortSignal.timeout(1_000) }));
});
