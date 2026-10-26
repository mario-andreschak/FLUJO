import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOfficialReleaseOrigin, assertVerifiedRevision, verifyReleaseRevision } from './release-verification.mjs';
import { assertVerificationJobs, REQUIRED_CHECK_NAMES } from './verification-contract.mjs';

const sha = 'a'.repeat(40);
function fixture({ fail = '', dirtyAfter = false, moveAfter = false } = {}) {
  const commands = [];
  let verificationEnded = false;
  const run = (command) => {
    if (command === 'git rev-parse HEAD') return moveAfter && verificationEnded ? 'b'.repeat(40) : sha;
    if (command === 'git status --porcelain') return dirtyAfter && verificationEnded ? ' M source.ts' : '';
    if (command.startsWith('git remote get-url')) return 'https://github.com/mario-andreschak/FLUJO.git';
    throw new Error(`Unexpected read ${command}`);
  };
  const show = (command) => {
    commands.push(command);
    if (command === fail) throw new Error('simulated failed gate');
    if (command === 'npm run smoke:mcp-artifacts') verificationEnded = true;
  };
  return {
    commands, run, show, removeResults: (file) => commands.push(`remove ${file}`),
    finishVerification: () => { verificationEnded = true; },
  };
}

test('verifies the exact version revision, build and packed artifacts without repeating the CI Jest suites', () => {
  const f = fixture();
  assert.equal(verifyReleaseRevision(f), sha);
  assert.equal(f.commands.some((command) => /test:ci|test:isolated|verify:test-baseline|^remove /.test(command)), false,
    'Jest evidence comes from the required exact-commit verify.yml run');
  assert.equal(f.commands.filter(command => command === 'npm run build').length, 1);
  assert.ok(f.commands.indexOf('npm run build') < f.commands.indexOf('npm run validate:mcp-release'));
  assert.equal(f.commands.at(-1), 'npm run smoke:mcp-artifacts');
});

for (const fail of [
  'npm run typecheck', 'npm run typecheck:mcp',
  'node scripts/generate-api-inventory.mjs --check',
  'node --test tests/installer-repository.test.mjs',
  'node --test scripts/run-local-jest.test.mjs',
  'node --test scripts/release-evidence.test.mjs',
  'node --test scripts/local-instance.test.mjs',
  'npm run test:dependency-glob', 'npm run lint:all', 'npm run build',
  'npm run validate:mcp-release', 'npm run smoke:mcp-artifacts',
]) {
  test(`does not authorize publishing when ${fail} fails`, () => {
    assert.throws(() => verifyReleaseRevision(fixture({ fail })), /simulated failed gate/);
  });
}

test('the Jest suites skipped by release preparation remain mandatory exact-commit release checks', () => {
  for (const name of ['test', 'test-isolated']) assert.ok(REQUIRED_CHECK_NAMES.includes(name));
  const passing = (names) => names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  assert.doesNotThrow(() => assertVerificationJobs(passing(REQUIRED_CHECK_NAMES)));
  for (const name of ['test', 'test-isolated']) {
    assert.throws(() => assertVerificationJobs(passing(REQUIRED_CHECK_NAMES.filter((check) => check !== name))), new RegExp(`check ${name} is missing`));
  }
});

test('a failed image publication safety gate cannot return release authority', () => {
  assert.throws(() => verifyReleaseRevision(fixture({ fail: 'node --test scripts/image-release.test.mjs' })), /simulated failed gate/);
});

for (const change of ['dirtyAfter', 'moveAfter']) {
  test(`refuses publishing when ${change} changes after verification`, () => {
    assert.throws(() => verifyReleaseRevision(fixture({ [change]: true })), /changed or.*dirty/);
  });
}

test('dirty or different commit cannot reuse verification', () => {
  assert.throws(() => assertVerifiedRevision(() => 'wrong', sha), /changed or.*dirty/);
});

test('release origin permits official HTTPS and SSH URLs only, including every push URL', () => {
  for (const url of ['https://github.com/mario-andreschak/FLUJO/', 'git@github.com:mario-andreschak/FLUJO.git', 'ssh://git@github.com/mario-andreschak/FLUJO.git']) {
    assert.doesNotThrow(() => assertOfficialReleaseOrigin(() => url));
  }
  for (const url of ['', 'https://github.com/other/FLUJO.git', 'https://github.com.evil.test/mario-andreschak/FLUJO', 'C:/repos/FLUJO', 'https://github.com/mario-andreschak/FLUJO.git\nhttps://github.com/other/FLUJO.git']) {
    for (const side of ['git remote get-url --all origin', 'git remote get-url --push --all origin']) {
      assert.throws(() => assertOfficialReleaseOrigin((command) => command === side ? url : 'https://github.com/mario-andreschak/FLUJO.git'), /official FLUJO repository/);
    }
  }
});

test('changing only the Git push configuration invalidates prior release verification', () => {
  assert.throws(() => assertVerifiedRevision((command) => {
    if (command === 'git rev-parse HEAD') return sha;
    if (command === 'git status --porcelain') return '';
    if (command === 'git remote get-url --all origin') return 'https://github.com/mario-andreschak/FLUJO.git';
    return 'https://github.com/other/FLUJO.git';
  }, sha), /official FLUJO repository/);
});

test('an injected candidate consumer smoke replaces repacking and runs after artifact validation', () => {
  const f = fixture();
  let calls = 0;
  assert.equal(verifyReleaseRevision({
    ...f,
    consumerSmoke: ({ run, show, revision }) => {
      calls += 1;
      assert.equal(run, f.run);
      assert.equal(show, f.show);
      assert.equal(revision, sha);
      assert.equal(f.commands.at(-1), 'npm run validate:mcp-release');
      show('consume exact candidate tarballs');
      f.finishVerification();
    },
  }), sha);
  assert.equal(calls, 1);
  assert.equal(f.commands.includes('npm run smoke:mcp-artifacts'), false);
  assert.equal(f.commands.at(-1), 'consume exact candidate tarballs');
});

test('a failed candidate consumer smoke cannot return publication authority', () => {
  assert.throws(() => verifyReleaseRevision({
    ...fixture(),
    consumerSmoke: () => { throw new Error('tested candidate could not start'); },
  }), /tested candidate could not start/);
});

for (const change of ['dirtyAfter', 'moveAfter']) {
  test(`candidate consumer smoke cannot authorize a release after ${change}`, () => {
    const f = fixture({ [change]: true });
    assert.throws(() => verifyReleaseRevision({
      ...f,
      consumerSmoke: () => f.finishVerification(),
    }), /changed or.*dirty/);
  });
}
