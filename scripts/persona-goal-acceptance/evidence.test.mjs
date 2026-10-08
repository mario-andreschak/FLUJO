import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fixture from './fixture.cjs';
import { validatePersonaGoalAcceptance } from '../validate-persona-goal-acceptance.mjs';

test('evidence validator rejects real effect tampering even when model/runtime claims still say passed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flujo-goal-evidence-'));
  try {
    const fixtureDir = path.join(directory, 'fixture');
    const facts = await fixture.createFixture(fixtureDir, 0);
    await fixture.callFixtureTool(fixtureDir, 'research_page');
    await fixture.callFixtureTool(fixtureDir, 'terminal', { command: 'node install-research-client.cjs' });
    await fixture.callFixtureTool(fixtureDir, 'research_page');
    for (const name of ['research.md', 'launch.md']) {
      await fixture.callFixtureTool(fixtureDir, 'write_artifact', { name, content: `Source ${facts.sourceId}: ${facts.audience}; ${facts.benefit}. A researched plan for FLUJO.` });
    }
    await fixture.callFixtureTool(fixtureDir, 'publish_campaign');
    await fixture.callFixtureTool(fixtureDir, 'publish_campaign');
    const model = { id: 'model', name: 'scripted-model', adapter: 'openai' };
    // Explicit synthetic records for the validator unit test, never acceptance output.
    const report = {
      schemaVersion: 1, runId: 'validator-unit-test', mode: 'offline', commitSha: 'a'.repeat(40), sourceDiffSha256: 'b'.repeat(64),
      startedAt: '2026-09-05T00:00:00Z', endedAt: '2026-09-05T00:01:00Z',
      configuration: { model, goalId: 'goal' }, modelCalls: [{ model: model.name, adapter: model.adapter }],
      checks: Object.fromEntries(['oneInitialGoal', 'autonomousContinuation', 'verifiedDeliverables', 'noHumanIntervention', 'noPrematureStop', 'controllerRestartRecovery', 'transientFailureRecovery', 'environmentBootstrapRecovery', 'actualModelObserved'].map(id => [id, true])),
      goals: [{ id: 'goal', goal: { state: 'completed', rounds: 4 } }], goalTasks: [], snapshots: [],
      activities: [1, 2, 3, 4].map(id => ({ id: `activity-${id}`, createdAt: id, source: { kind: 'assignment', sourceId: 'goal' } })),
      mailbox: [1, 2, 3, 4].map(id => ({ idempotencyKey: `round-${id}`, claimedActivityId: `activity-${id}`, source: { kind: 'assignment', sourceId: 'goal' } })),
      observations: { restartAt: 2, roundsBeforeRestart: 1 }, external: await fixture.verifyFixture(fixtureDir),
    };
    const raw = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(path.join(directory, 'persona-goal-acceptance.json'), raw);
    await writeFile(path.join(directory, 'SHA256SUMS'), `${createHash('sha256').update(raw).digest('hex')}  persona-goal-acceptance.json\n`);
    const input = { directory, expectedCommit: report.commitSha, expectedMode: 'offline', expectedSourceDiffSha256: report.sourceDiffSha256 };
    await validatePersonaGoalAcceptance(input);
    await assert.rejects(validatePersonaGoalAcceptance({ ...input, expectedMode: 'live' }), /Mode identity mismatch/);
    await appendFile(path.join(fixtureDir, 'launch.md'), '\nChanged after publication.');
    await assert.rejects(validatePersonaGoalAcceptance(input), /Actual artifacts\/publication/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
