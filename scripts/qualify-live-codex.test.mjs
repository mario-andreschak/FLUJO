import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { cases, requirePrivatePath, qualifyLiveCodex, verifyLiveResult } from './qualify-live-codex.mjs';

const checkout = path.join(os.tmpdir(), 'qualification-contract-checkout');
function successful(selected) {
  const result = { success: true, wasInterrupted: false, testResults: [{ name: path.join(checkout, selected[1]), status: 'passed',
    assertionResults: [{ status: 'passed' }] }] };
  const receipt = { kind: selected[2], model: 'gpt-6-luna', effort: 'medium', observedAt: new Date().toISOString(),
    countsAsRequestedSwarm: false, countsAsBusinessWork: false, billedSpendUsd: null, billedCostUsd: null };
  return { result, receipt };
}

test('qualification refuses absent configuration before any provider process', async () => {
  await assert.rejects(qualifyLiveCodex({}), /Absolute private/);
  assert.throws(() => requirePrivatePath('relative'), /Absolute private/);
  assert.throws(() => requirePrivatePath(checkout, checkout), /outside/);
  assert.throws(() => requirePrivatePath(path.join(checkout, 'auth.json'), checkout), /outside/);
  assert.equal(requirePrivatePath(path.join(os.tmpdir(), 'private-qualification'), checkout), path.join(os.tmpdir(), 'private-qualification'));
});

test('all exact live checks require executed assertions and independent receipts', () => {
  for (const selected of cases) {
    const { result, receipt } = successful(selected);
    verifyLiveResult(result, receipt, selected, checkout);
    for (const status of ['pending', 'skipped', 'failed']) {
      const omitted = structuredClone(result); omitted.testResults[0].assertionResults[0].status = status;
      assert.throws(() => verifyLiveResult(omitted, receipt, selected, checkout), /execute and pass/);
    }
    for (const bad of [{ ...result, wasInterrupted: true }, { ...result, success: false }, { ...result, testResults: [] }]) {
      assert.throws(() => verifyLiveResult(bad, receipt, selected, checkout), /execute and pass/);
    }
    const foreign = structuredClone(result); foreign.testResults[0].name = path.join(checkout, 'other.test.ts');
    assert.throws(() => verifyLiveResult(foreign, receipt, selected, checkout), /exact test/);
    for (const bad of [undefined, { ...receipt, kind: 'fixture' }, { ...receipt, model: 'other' },
      { ...receipt, effort: 'low' }, { ...receipt, observedAt: 'invalid' },
      { ...receipt, billedSpendUsd: 0, billedCostUsd: 0 }]) {
      assert.throws(() => verifyLiveResult(result, bad, selected, checkout), /receipt/);
    }
  }
});
