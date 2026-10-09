import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertRepositoryRules, inspectRepositoryRules } from './verify-repository-rules.mjs';

const policy = JSON.parse(readFileSync(new URL('../.github/rulesets/main-verification.json', import.meta.url), 'utf8'));
const fixture = () => ({ rules: structuredClone(policy.rules).map((rule) => ({ ...rule, ruleset_id: 7 })), rulesets: [{ ...structuredClone(policy), id: 7 }] });

test('administrator template matches the read-only effective-rule auditor', () => assertRepositoryRules(fixture()));

for (const [label, change] of [
  ['disabled ruleset', (f) => { f.rulesets[0].enforcement = 'disabled'; }],
  ['bot bypass', (f) => { f.rulesets[0].bypass_actors = [{ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }]; }],
  ['hidden bypass list', (f) => { delete f.rulesets[0].bypass_actors; }],
  ['empty effective rules', (f) => { f.rules = []; }],
  ['human code-owner review', (f) => { f.rules.find((r) => r.type === 'pull_request').parameters.require_code_owner_review = true; }],
  ['stale checks permitted', (f) => { f.rules.find((r) => r.type === 'required_status_checks').parameters.strict_required_status_checks_policy = false; }],
  ['missing required check', (f) => { f.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks.pop(); }],
  ['spoofable check source', (f) => { f.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = null; }],
  ['extra scanner merge gate', (f) => { f.rules.push({ type: 'code_scanning', ruleset_id: 7 }); }],
]) {
  test(`auditor refuses ${label}`, () => { const f = fixture(); change(f); assert.throws(() => assertRepositoryRules(f)); });
}

test('auditor reads effective branch rules and contributing rulesets without mutation', () => {
  const f = fixture();
  const endpoints = [];
  const result = inspectRepositoryRules({ branch: 'codex/disposable-probe', api: (endpoint) => {
    endpoints.push(endpoint);
    return endpoint.endsWith('/rulesets/7') ? f.rulesets[0] : f.rules;
  } });
  assert.equal(result.branch, 'codex/disposable-probe');
  assert.deepEqual(endpoints, ['repos/mario-andreschak/FLUJO/rules/branches/codex%2Fdisposable-probe', 'repos/mario-andreschak/FLUJO/rulesets/7']);
  assert.throws(() => inspectRepositoryRules({ branch: '../main', api: () => { throw new Error('must not call'); } }), /Invalid branch/);
});
