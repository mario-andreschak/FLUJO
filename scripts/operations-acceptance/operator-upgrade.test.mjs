import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { assertDiagnosticRevision, concludeOperatorAttempt, openOfflineArchive, parseOperatorUpgradeArguments, sealOfflineArchive } from './operator-upgrade.mjs';
import { recoveryBudget } from '../worker-recovery-runtime.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const absolute = name => path.resolve(name);
const argumentsFor = () => ['--baseline-application', absolute('baseline'), '--candidate-application', absolute('candidate'),
  '--baseline-build-evidence', absolute('baseline-build.json'), '--candidate-build-evidence', absolute('candidate-build.json'), '--report', absolute('report.json')];

test('operator equipment requires distinct absolute source applications and unique known inputs', () => {
  assert.equal(parseOperatorUpgradeArguments(argumentsFor()).report, absolute('report.json'));
  const same = argumentsFor(); same[3] = same[1]; assert.throws(() => parseOperatorUpgradeArguments(same));
  const duplicate = argumentsFor(); duplicate[2] = duplicate[0]; assert.throws(() => parseOperatorUpgradeArguments(duplicate));
  const relative = argumentsFor(); relative[1] = 'relative'; assert.throws(() => parseOperatorUpgradeArguments(relative));
  assert.throws(() => parseOperatorUpgradeArguments(argumentsFor().concat('--release')));
});

test('stopped backup authenticates exact encrypted bytes and refuses a different protection key', () => {
  const key = randomBytes(32), plaintext = Buffer.from('private fixture data'), sealed = sealOfflineArchive(plaintext, key);
  assert.deepEqual(openOfflineArchive(sealed, digest(sealed), key), plaintext);
  assert.throws(() => openOfflineArchive(sealed, digest(sealed), randomBytes(32)));
  assert.throws(() => openOfflineArchive(sealed, '0'.repeat(64), key));
  const modified = Buffer.from(sealed); modified[modified.length - 2] ^= 1;
  assert.throws(() => openOfflineArchive(modified, digest(sealed), key));
  // Recomputing the outer digest does not bypass authenticated encryption.
  const envelope = JSON.parse(sealed), data = Buffer.from(envelope.data, 'base64'); data[0] ^= 1;
  const forged = Buffer.from(JSON.stringify({ ...envelope, data: data.toString('base64') }));
  assert.throws(() => openOfflineArchive(forged, digest(forged), key));
});

const completedAttempt = () => ({
  budget: recoveryBudget(), providerClosed: true, providerHandlersSettled: true,
  requests: [
    { sequence: 1, mode: 'failure', generation: 1, credentialMatched: true },
    { sequence: 2, mode: 'success', generation: 3, credentialMatched: true },
    { sequence: 3, mode: 'success', generation: 4, credentialMatched: true },
  ],
  checks: [1, 1, 2, 2, 3, 3, 4].map(generation => ({ generation })),
  generations: ['baseline', 'candidate', 'candidate', 'baseline'].map((role, index) => ({
    generation: index + 1, role, pid: index + 10, parentExitObserved: true, stdioCloseObserved: true,
    nextExitObserved: true, listenerClosed: true, registrationRemoved: true, abandoned: false, failure: null,
    nextHandle: { kind: 'original-next-handle', pid: index + 20, launcherPid: index + 10, startedAt: 'original-fixture-birth' },
    nextExit: { kind: 'original-next-exit', pid: index + 20, startedAt: 'original-fixture-birth' },
    nextHandleObserver: { parentExitObserved: true, stdioCloseObserved: true, exitCode: 0 },
  })),
});

test('operator attention from a mismatched or absent revision cannot qualify diagnosis', () => {
  assert.doesNotThrow(() => assertDiagnosticRevision({ checks: { revision: 'self-report-matches' } }));
  for (const revision of ['self-report-mismatch', 'self-report-missing', undefined]) {
    assert.throws(() => assertDiagnosticRevision({ exitCode: 2, checks: { revision } }), /matching source revision/);
  }
});

test('late callback refusal fails a fully observed operator attempt', async () => {
  const attempt = completedAttempt(), late = new Error('late fixture callback refusal');
  assert.equal(concludeOperatorAttempt(attempt), undefined);
  await new Promise(resolve => queueMicrotask(() => { attempt.budget.refuse(late); resolve(); }));
  assert.equal(concludeOperatorAttempt(attempt), late);
});

test('fourth effect, wrong generation or unmatched credential cannot pass final census', () => {
  const extra = completedAttempt(); extra.requests.push({ sequence: 4, mode: 'success', generation: 4, credentialMatched: true });
  assert.match(concludeOperatorAttempt(extra).message, /exactly the three/);
  const wrongGeneration = completedAttempt(); wrongGeneration.requests[1].generation = 2;
  assert.match(concludeOperatorAttempt(wrongGeneration).message, /exactly the three/);
  const wrongCredential = completedAttempt(); wrongCredential.requests[2].credentialMatched = false;
  assert.match(concludeOperatorAttempt(wrongCredential).message, /exactly the three/);
});

test('unsettled callbacks, missing checkpoints and incomplete original exits cannot pass', () => {
  const callbacks = completedAttempt(); callbacks.providerHandlersSettled = false;
  assert.match(concludeOperatorAttempt(callbacks).message, /all admitted handlers/);
  const checkpoint = completedAttempt(); checkpoint.checks.pop();
  assert.match(concludeOperatorAttempt(checkpoint).message, /seven source-operator checkpoints/);
  const original = completedAttempt(); original.generations[3].nextExit.startedAt = 'replacement-fixture-birth';
  assert.match(concludeOperatorAttempt(original).message, /every original launcher/);
});

test('a failed main journey retains its original error when final census is also incomplete', () => {
  const attempt = completedAttempt(), original = new Error('original main journey failure');
  attempt.failure = original; attempt.requests.pop();
  assert.equal(concludeOperatorAttempt(attempt), original);
});
