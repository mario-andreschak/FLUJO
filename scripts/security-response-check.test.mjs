import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  REPOSITORY, RESPONSE_TARGETS, TRIAGE_DECISIONS, TRIAGE_FILE,
  collectSecurityState, evaluateSecurityResponse, formatReport, parseTriage,
} from './security-response-check.mjs';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const daysAgo = (days) => new Date(NOW - days * 86_400_000).toISOString();
const codeAlert = (number, severity, days, path = 'src/a.ts', rule = 'js/command-line-injection') => ({
  number, created_at: daysAgo(days), rule: { id: rule, security_severity_level: severity },
  most_recent_instance: { location: { path } },
});
const dependabotAlert = (number, severity, days, name = 'hono', ghsa = 'GHSA-aaaa-bbbb-cccc') => ({
  number, created_at: daysAgo(days), security_advisory: { severity, ghsa_id: ghsa }, dependency: { package: { name } },
});
const entry = (overrides = {}) => ({
  source: 'code-scanning', number: 1, rule: 'js/command-line-injection', location: 'src/a.ts',
  decision: 'false-positive', reason: 'A written reason that a reviewer can check against the code.',
  reviewed: '2026-11-20', revisitBy: '2027-05-01', ...overrides,
});
const triage = (...alerts) => ({ schemaVersion: 1, alerts });

test('response targets get stricter with severity and every decision expires', () => {
  assert.deepEqual(Object.keys(RESPONSE_TARGETS), ['critical', 'high', 'medium', 'low']);
  const fix = Object.values(RESPONSE_TARGETS).map(({ fix: days }) => days);
  assert.deepEqual(fix, [...fix].sort((a, b) => a - b));
  for (const { triage: first, fix: days } of Object.values(RESPONSE_TARGETS)) assert.ok(first < days);
  for (const days of Object.values(TRIAGE_DECISIONS)) assert.ok(days > 0 && days <= 180);
});

test('an old critical or high alert without a reason fails, a young one only waits', () => {
  const result = evaluateSecurityResponse({
    now: NOW, privateReporting: true, triage: triage(),
    codeScanning: [codeAlert(1, 'critical', 8), codeAlert(2, 'high', 3), codeAlert(3, 'medium', 120)],
    dependabot: [dependabotAlert(4, 'high', 31)],
  });
  assert.deepEqual(result.rows.map(({ key, status }) => [key, status]), [
    ['dependabot#4', 'overdue'], ['code-scanning#1', 'overdue'], ['code-scanning#2', 'new'], ['code-scanning#3', 'overdue'],
  ]);
  assert.equal(result.failures.length, 2, 'medium and low alerts past their target are reported, not fatal');
  assert.match(result.failures.join('\n'), /code-scanning#1 \(critical/);
  assert.match(result.failures.join('\n'), /dependabot#4 \(high/);
});

test('a current written reason handles an alert; an expired or moved one sends it back to the queue', () => {
  const alerts = [codeAlert(1, 'high', 60), codeAlert(2, 'high', 60), codeAlert(3, 'high', 60, 'src/moved.ts')];
  const result = evaluateSecurityResponse({
    now: NOW, privateReporting: true, codeScanning: alerts,
    triage: triage(
      entry({ number: 1 }),
      entry({ number: 2, decision: 'fixed-pending-scan', reviewed: '2026-10-01', revisitBy: '2026-10-30' }),
      entry({ number: 3 }),
      entry({ number: 99 }),
    ),
  });
  assert.deepEqual(result.rows.map(({ number, status }) => [number, status]), [[1, 'triaged'], [2, 'overdue'], [3, 'overdue']]);
  assert.ok(result.rows[1].expiredOrMoved && result.rows[2].expiredOrMoved);
  assert.deepEqual(result.stale, ['code-scanning#99']);
  assert.equal(result.failures.length, 2);
});

test('private vulnerability reporting must stay on', () => {
  const result = evaluateSecurityResponse({ now: NOW, privateReporting: false, triage: triage() });
  assert.match(result.failures[0], /Private vulnerability reporting is off/);
});

for (const [label, bad] of [
  ['missing reason', entry({ reason: 'fine' })],
  ['unknown decision', entry({ decision: 'ignore' })],
  ['permanent exception', entry({ reviewed: '2026-01-01', revisitBy: '2030-01-01' })],
  ['fix that never gets rescanned', entry({ decision: 'fixed-pending-scan', reviewed: '2026-11-01', revisitBy: '2027-01-30' })],
  ['missing location', entry({ location: '' })],
  ['unknown source', entry({ source: 'secret-scanning' })],
]) {
  test(`the triage file refuses a ${label}`, () => {
    assert.throws(() => parseTriage(triage(bad)));
  });
}

test('the triage file refuses duplicates and a wrong schema', () => {
  assert.throws(() => parseTriage(triage(entry(), entry())), /repeats/);
  assert.throws(() => parseTriage({ alerts: [] }), /schemaVersion/);
});

test('the committed triage file is valid and gives a reason for every listed alert', () => {
  const document = JSON.parse(readFileSync(TRIAGE_FILE, 'utf8'));
  const entries = parseTriage(document);
  assert.ok(entries.length > 0);
  for (const item of entries) assert.ok(item.reason.length >= 40, item.key);
});

test('live collection reads reporting status and every alert page without changing anything', () => {
  const calls = [];
  const state = collectSecurityState({ api: (endpoint, paginate) => {
    calls.push([endpoint, Boolean(paginate)]);
    if (endpoint.endsWith('/private-vulnerability-reporting')) return '{"enabled":true}';
    if (endpoint.includes('/dependabot/')) return `${JSON.stringify(dependabotAlert(5, 'low', 1))}\n`;
    return `${JSON.stringify(codeAlert(6, 'medium', 1))}\n${JSON.stringify(codeAlert(7, 'low', 1))}\n`;
  } });
  assert.deepEqual(calls, [
    [`repos/${REPOSITORY}/private-vulnerability-reporting`, false],
    [`repos/${REPOSITORY}/dependabot/alerts?state=open&per_page=100`, true],
    [`repos/${REPOSITORY}/code-scanning/alerts?state=open&per_page=100`, true],
  ]);
  assert.equal(state.privateReporting, true);
  assert.deepEqual(state.codeScanning.map(({ number }) => number), [6, 7]);
  const report = formatReport(evaluateSecurityResponse({ now: NOW, triage: triage(), ...state }), NOW);
  assert.match(report, /Open alerts: 3 \(0 critical, 0 high, 1 medium, 2 low\)/);
  assert.doesNotMatch(report, /FAILED/);
});
