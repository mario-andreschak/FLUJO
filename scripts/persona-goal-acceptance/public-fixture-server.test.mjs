import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTROLLED_PUBLIC_FIXTURE_MANIFEST,
  validatePublicFixtureManifest,
} from './public-fixture-manifest.mjs';
import { startPublicFixtureServer } from './public-fixture-server.mjs';

test('controlled service reconciles commit-before-ack with one idempotent effect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flujo-public-fixture-'));
  const verifierRoot = path.join(root, 'trusted');
  const agentRoot = path.join(root, 'agent');
  const token = 'unit-test-ephemeral-token';
  await mkdir(agentRoot, { recursive: true });
  const fixture = await startPublicFixtureServer({
    verifierRoot,
    agentRoot,
    runId: 'fixture-unit-run',
    token,
    acknowledgementHoldMs: 30_000,
  });
  try {
    const headers = {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'publication:fixture-unit-run',
    };
    const research = await (await fetch(fixture.baseUrl + '/research.json')).json();
    const content = name => '# ' + name + '\nSource: ' + research.facts.sourceId
      + '\nAudience: ' + research.facts.audience
      + '\nBenefit: ' + research.facts.benefit
      + '\nUseful controlled evidence for the approved developer community.';
    await Promise.all([
      writeFile(path.join(agentRoot, 'research.md'), content('research')),
      writeFile(path.join(agentRoot, 'launch.md'), content('launch')),
      writeFile(path.join(agentRoot, 'backlog.md'), content('backlog')),
    ]);

    const limited = await fetch(fixture.baseUrl + '/publish', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(limited.status, 429);

    const controller = new AbortController();
    const uncertain = fetch(fixture.baseUrl + '/publish', {
      method: 'POST',
      headers,
      body: '{}',
      signal: controller.signal,
    }).catch(error => error);
    while ((await fixture.readEvidence()).state.effects.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await uncertain;

    const readback = await fetch(fixture.baseUrl + '/publication', {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(readback.status, 200);
    const body = await readback.json();
    assert.equal(body.publication.idempotencyKey, 'publication:fixture-unit-run');

    const replay = await fetch(fixture.baseUrl + '/publish', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);

    const cleanup = await fetch(fixture.baseUrl + '/publication', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(cleanup.status, 200);
    const evidence = await fixture.readEvidence();
    assert.equal(evidence.state.effects.length, 1);
    assert.equal(evidence.state.acknowledgementState, 'reconciled');
    assert.equal(evidence.state.cleanup.status, 'completed');
    assert.equal(evidence.audit.some(event =>
      event.type === 'publication_committed_ack_withheld'), true);
    assert.equal(evidence.audit.some(event =>
      event.type === 'publication_uncertain_effect_reconciled'), true);
  } finally {
    await fixture.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest rejects embedded credentials and unapproved public effects', () => {
  const embedded = structuredClone(CONTROLLED_PUBLIC_FIXTURE_MANIFEST);
  embedded.account.token = 'do-not-store-me';
  assert.throws(() => validatePublicFixtureManifest(embedded), /Embedded credentials/);

  const publicManifest = structuredClone(CONTROLLED_PUBLIC_FIXTURE_MANIFEST);
  publicManifest.serviceClass = 'genuine-public';
  publicManifest.effectScope.publicInternet = true;
  publicManifest.baseUrl = 'https://example.invalid';
  assert.throws(() => validatePublicFixtureManifest(publicManifest), /explicit runner opt-in/);
});
