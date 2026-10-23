import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyRecoveryQualification } from './qualify-conversation-recovery.mjs';

function fixture() {
  const routes = ['codex', 'openrouter'];
  return {
    result: { success: true, wasInterrupted: false, testResults: [{
      name: fileURLToPath(new URL('../__tests__/model/conversationRecovery.live.test.ts', import.meta.url)),
      status: 'passed', assertionResults: routes.map(route => ({ fullName: `continues through an oversized tool result on ${route}`, status: 'passed' })),
    }] },
    receipts: Object.fromEntries(routes.map(route => [route, { route, status: 'passed',
      model: route === 'codex' ? 'gpt-6-luna' : 'openrouter/free',
      exactTailRecovered: true, canonicalOriginalPreserved: true, inputCharacters: 1_100_050 }])),
  };
}

test('live recovery needs both exact cases and approved model receipts', () => {
  const { result, receipts } = fixture();
  verifyRecoveryQualification(result, receipts);
});
for (const [label, mutate] of [
  ['a skipped case behind a green aggregate', f => { f.result.testResults[0].assertionResults[1].status = 'pending'; }],
  ['missing source recovery proof', f => { f.receipts.codex.exactTailRecovered = false; }],
  ['altered canonical history', f => { f.receipts.openrouter.canonicalOriginalPreserved = false; }],
  ['an unapproved provider model', f => { f.receipts.openrouter.model = 'paid-model'; }],
  ['duplicate or omitted route', f => { f.result.testResults[0].assertionResults[1] = f.result.testResults[0].assertionResults[0]; }],
]) {
  test(`live recovery refuses ${label}`, () => {
    const f = fixture(); mutate(f);
    assert.throws(() => verifyRecoveryQualification(f.result, f.receipts), /did not pass/);
  });
}
