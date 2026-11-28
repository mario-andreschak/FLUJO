import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { RESULT_PREFIX } from './container-smoke/inside.mjs';
import { checkContainerBase, parseOptions, readPhaseResult, summarize } from './smoke-container-image.mjs';
import { containerBaseRecord } from './verify-ci-node.mjs';

test('options need an image and an absolute report path', () => {
  assert.deepEqual(parseOptions(['--image', 'sha256:abc']), { image: 'sha256:abc', report: undefined, keep: false });
  assert.throws(() => parseOptions([]), /--image needs/);
  assert.throws(() => parseOptions(['--image', 'img', '--report', 'relative.json']), /absolute path/);
  assert.throws(() => parseOptions(['--image', 'img; rm -rf /']), /--image needs/);
  assert.throws(() => parseOptions(['--image', 'img', '--unknown']), /Unknown option/);
});

test('the last result line of a phase is read; other output is ignored', () => {
  const stdout = ['starting', `${RESULT_PREFIX}{"ok":false,"error":"old"}`, 'noise', `${RESULT_PREFIX}{"ok":true,"phase":"voice"}`, ''].join('\n');
  assert.deepEqual(readPhaseResult(stdout), { ok: true, phase: 'voice' });
  assert.equal(readPhaseResult('no result here'), undefined);
});

test('the registry check reads the pinned index from the mirror, then Docker Hub, and refuses other bytes', async () => {
  const record = containerBaseRecord();
  const index = { schemaVersion: 2, mediaType: record.mediaType, manifests: [
    { digest: record.linuxAmd64, platform: { os: 'linux', architecture: 'amd64' } }] };
  const bytes = Buffer.from(JSON.stringify(index));
  const matching = { ...record, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://mirror.gcr.io/')) return new Response('down', { status: 503 });
    if (url.startsWith('https://auth.docker.io/')) return Response.json({ token: 'anonymous' });
    return new Response(bytes);
  };
  const pause = async () => {};
  assert.deepEqual(await checkContainerBase({ fetchImpl, pause, record: matching }),
    { reference: record.reference, registry: 'Docker Hub', linuxAmd64: record.linuxAmd64 });
  assert.equal(calls.filter((url) => url.startsWith('https://mirror.gcr.io/')).length, 3);
  assert.ok(calls.includes(`https://registry-1.docker.io/v2/library/node/manifests/${matching.digest}`));
  // Bytes that do not hash to the recorded digest are refused at once, not retried elsewhere.
  calls.length = 0;
  await assert.rejects(checkContainerBase({ fetchImpl, pause }), /differs from the pinned container base digest/);
  assert.equal(calls.filter((url) => url.startsWith('https://registry-1.docker.io/')).length, 1);
  await assert.rejects(checkContainerBase({ fetchImpl: async () => { throw new Error('offline'); }, pause: async () => {} }), /could not be read from any registry/);
});

test('the summary lists every check and the voice timings', () => {
  const run = (totalMs, beforeModelMs, mcpLists, saves, claimed = false) => ({ totalMs, beforeModelMs, mcpLists, saves, claimed });
  const series = (on) => ({ scenarios: Object.fromEntries(['direct', 'tool', 'continue'].map((scenario) => [scenario,
    { runs: [run(3000, 1500, 2, 8), run(on ? 900 : 2800, on ? 200 : 1400, on ? 0 : 2, on ? 3 : 8, on), run(on ? 800 : 2700, on ? 180 : 1300, on ? 0 : 2, on ? 3 : 8)] }])) });
  const text = summarize({ result: 'passed', imageId: 'sha256:1', node: 'v24.22.1', checks: [{ title: 'Health', result: 'passed' }, { title: 'Chat', result: 'failed', error: 'no answer\nlogs' }],
    phases: { voice: { series: { off: series(false), on: series(true) } } } });
  assert.match(text, /PASS Health/);
  assert.match(text, /FAIL Chat: no answer\n/);
  assert.match(text, /\| direct \| off \| 3000 \| 2750 \| 1350 \| 0 of 2 \| 2 \| 8 \|/);
  assert.match(text, /\| tool \| on \| 3000 \| 850 \| 190 \| 1 of 2 \| 0 \| 3 \|/);
});
