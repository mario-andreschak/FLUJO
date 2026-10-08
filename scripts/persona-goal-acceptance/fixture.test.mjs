import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fixture from './fixture.cjs';

test('verifies unique researched facts and actual publication after a transient failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flujo-goal-fixture-'));
  try {
    const facts = await fixture.createFixture(directory, 0);
    assert.equal((await fixture.callFixtureTool(directory, 'research_page')).isError, true);
    await fixture.callFixtureTool(directory, 'terminal', { command: 'cat README.md' });
    await fixture.callFixtureTool(directory, 'terminal', { command: 'node install-research-client.cjs' });
    assert.equal((await fixture.callFixtureTool(directory, 'research_page')).isError, undefined);
    const bad = await fixture.callFixtureTool(directory, 'write_artifact', { name: 'research.md', content: 'The model claims the research is done, without actual source facts.' });
    assert.equal(bad.isError, true);
    const content = `FLUJO campaign research cites ${facts.sourceId}. Audience: ${facts.audience}. Benefit: ${facts.benefit}.`;
    for (const name of ['research.md', 'launch.md']) await fixture.callFixtureTool(directory, 'write_artifact', { name, content });
    assert.equal((await fixture.callFixtureTool(directory, 'publish_campaign')).isError, true);
    await fixture.callFixtureTool(directory, 'publish_campaign');
    const evidence = await fixture.verifyFixture(directory);
    assert.equal(evidence.publicationVerified, true);
    assert.equal(evidence.transientFailureObserved, true);
    assert.equal(evidence.environmentBootstrapVerified, true);
    assert.equal(evidence.publishAttempts, 2);
    assert.equal(evidence.artifacts.every(artifact => artifact.verified), true);
    await writeFile(path.join(directory, 'launch.md'), `${await readFile(path.join(directory, 'launch.md'), 'utf8')} changed`);
    assert.equal((await fixture.verifyFixture(directory)).publicationVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
