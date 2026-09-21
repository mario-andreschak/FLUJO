import assert from 'node:assert/strict';

export const journeyTestTitle = 'Role → Persona → Core/Behavior/Apps → Memory → Chat → queued Task → restart → History/export';
export const journeySteps = Object.freeze([
  'Create a Role with two suggested Apps',
  'Create a Persona, accept one suggested App and replace another',
  'Select a model-ready Core and add a shared Behavior',
  'Make a Persona-owned Behavior copy',
  'Add, correct, pin/unpin and forget a Memory, retaining earlier history',
  'Save a Task and chat through the Core, copied Behavior and granted App',
  'Queue the saved Task while busy; restart and run it exactly once',
  'Filter History, export only configuration, and cancel deletion preview',
  'Keep the second workspace isolated',
]);

export function validateJourneyIdentity({ commit, runId, buildId }) {
  assert.match(commit ?? '', /^[0-9a-f]{40}$/, 'A full lowercase commit SHA is required.');
  assert.match(runId ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'A bounded run identity is required.');
  assert.ok(typeof buildId === 'string' && buildId.trim() === buildId && buildId.length > 0, 'Build identity is missing.');
}

function attachment(result, name) {
  const matches = result.attachments?.filter(item => item.name === name) ?? [];
  assert.equal(matches.length, 1, `Exactly one ${name} attachment is required.`);
  const item = matches[0];
  // testInfo.attach({ body }) is embedded as base64 by the installed JSON reporter.
  // Do not follow arbitrary attachment paths or depend on a runner's absolute path.
  assert.equal(item.contentType, 'application/json');
  assert.ok(typeof item.body === 'string' && item.body.length > 0, `${name} must be embedded.`);
  return JSON.parse(Buffer.from(item.body, 'base64').toString('utf8'));
}

function specs(suites) {
  return suites.flatMap(suite => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
}

export function validateJourneyReport(report, identity, sourceBefore, sourceAfter) {
  validateJourneyIdentity(identity);
  const checkedAt = source => {
    assert.equal(source?.schemaVersion, 1);
    assert.equal(source.verdict, 'passed', 'Both source checks must pass.');
    assert.deepEqual(source.identity, identity, 'Source identity differs from the requested run.');
    const time = Date.parse(source.observedAt);
    assert.ok(Number.isFinite(time), 'Source check timestamp is missing.');
    return time;
  };
  const before = checkedAt(sourceBefore);
  const after = checkedAt(sourceAfter);
  assert.equal(sourceBefore.phase, 'before');
  assert.equal(sourceAfter.phase, 'after');
  assert.deepEqual(report.errors, [], 'Reporter errors invalidate acceptance.');
  assert.deepEqual({ expected: report.stats?.expected, unexpected: report.stats?.unexpected,
    flaky: report.stats?.flaky, skipped: report.stats?.skipped },
  { expected: 1, unexpected: 0, flaky: 0, skipped: 0 }, 'The complete journey must pass once without skips or retries.');
  const startedAt = Date.parse(report.stats.startTime);
  assert.ok(Number.isFinite(startedAt) && Number.isFinite(report.stats.duration) && report.stats.duration > 0);
  assert.ok(before <= startedAt && after >= startedAt + report.stats.duration, 'Source checks must bracket the browser run.');
  const cases = specs(report.suites ?? []);
  assert.equal(cases.length, 1, 'Exactly the complete journey is required.');
  const spec = cases[0];
  assert.equal(spec.title, journeyTestTitle);
  assert.match(spec.file ?? '', /(?:^|\/)journey\.spec\.mjs$/);
  assert.equal(spec.ok, true);
  assert.equal(spec.tests?.length, 1);
  const test = spec.tests[0];
  assert.equal(test.expectedStatus, 'passed', 'Expected-failure tests cannot prove acceptance.');
  assert.equal(test.status, 'expected');
  assert.equal(test.results?.length, 1, 'Retries cannot substitute for a clean journey.');
  const result = test.results[0];
  assert.equal(result.status, 'passed');
  assert.equal(result.retry, 0);
  assert.ok(!result.error);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.steps?.map(step => step.title), journeySteps, 'A required journey step is missing or reordered.');
  const inspectSteps = steps => steps.forEach(step => { assert.ok(!step.error, `Step failed: ${step.title}`); inspectSteps(step.steps ?? []); });
  inspectSteps(result.steps);
  const observation = attachment(result, 'journey-observations');
  assert.equal(observation.mode, 'deterministic-browser-journey');
  assert.equal(observation.qualityReview, 'not_evaluated');
  assert.deepEqual(observation.source, { commit: identity.commit, runId: identity.runId });
  assert.equal(observation.buildId, identity.buildId);
  assert.deepEqual(observation.steps?.map(step => step.name), journeySteps);
  let lastStep = startedAt;
  for (const step of observation.steps) {
    const time = Date.parse(step.passedAt);
    assert.ok(Number.isFinite(time) && time >= lastStep && time <= startedAt + report.stats.duration, 'Step completion timestamps are invalid.');
    lastStep = time;
  }
  const final = observation.finalState;
  assert.ok(final?.persona?.id, 'Persisted Persona state is missing.');
  assert.equal(final.persona.composition.coreFlowRef, 'journey-core');
  const specialist = final.persona.composition.behaviors.find(item => item.name === 'Journey receipt specialist');
  assert.equal(specialist?.binding.mode, 'persona_copy');
  assert.equal(specialist.binding.sharedFlowRef, 'journey-specialist');
  assert.ok(specialist.binding.personaFlowRef && specialist.binding.personaFlowRef !== 'journey-specialist');
  assert.deepEqual(final.appGrants.map(item => item.mcpServerName).sort(), ['Journey receipt App', 'Journey replacement App']);
  assert.equal(final.memoryItems.find(item => item.content === 'The journey meeting is on Wednesday.')?.status, 'forgotten');
  assert.equal(final.memoryItems.find(item => item.content === 'The journey meeting is on Tuesday.')?.status, 'superseded');
  assert.equal(final.workItems.find(item => item.title === 'Journey saved receipt')?.status, 'completed');
  const assignments = final.activities.filter(item => item.kind === 'assignment');
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].status, 'completed');
  assert.equal(assignments[0].outcome?.resolution, 'succeeded');
  const cleanup = attachment(result, 'journey-final-process-and-effect-record');
  assert.equal(cleanup.epochs?.length, 2);
  assert.ok(cleanup.epochs.every(epoch => Number.isInteger(epoch.pid) && epoch.pid > 0
    && Number.isFinite(Date.parse(epoch.exitedAt)) && [0, 143].includes(epoch.exitCode)), 'Both owned processes must have stopped.');
  assert.notEqual(cleanup.epochs[0].pid, cleanup.epochs[1].pid);
  assert.equal(cleanup.fixtureEvents?.filter(event => event.kind === 'fixture_error').length, 0);
  for (const token of ['JOURNEY_CHAT', 'JOURNEY_TASK']) {
    const effects = cleanup.fixtureEvents.filter(event => event.kind === 'app_completed' && event.token === token);
    assert.equal(effects.length, 1, `${token} must have exactly one completed App effect.`);
    assert.equal(effects[0].receipt, `JOURNEY-APP-RECEIPT:${token}`);
  }
  return { schemaVersion: 1, verdict: 'passed', identity, requiredSteps: journeySteps.length,
    testTitle: journeyTestTitle, qualityReview: 'not_evaluated', mode: observation.mode,
    sourceCheckedBefore: sourceBefore.observedAt, sourceCheckedAfter: sourceAfter.observedAt };
}
