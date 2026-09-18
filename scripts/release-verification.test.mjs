import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOfficialReleaseOrigin, assertVerifiedRevision, verifyReleaseRevision } from './release-verification.mjs';

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
  return { commands, run, show, removeResults: (file) => commands.push(`remove ${file}`) };
}

test('verifies exact version revision and fresh main/isolated evidence before returning publish authority', () => {
  const f = fixture();
  assert.equal(verifyReleaseRevision(f), sha);
  assert.ok(f.commands.indexOf('remove jest-results.json') < f.commands.indexOf('npm run test:ci'));
  assert.ok(f.commands.includes('npm run verify:test-baseline -- --stage=isolated --results=jest-results-isolated.json'));
  assert.equal(f.commands.filter(command => command === 'npm run build').length, 1);
  assert.ok(f.commands.indexOf('npm run build') < f.commands.indexOf('npm run validate:mcp-release'));
  assert.equal(f.commands.at(-1), 'npm run smoke:mcp-artifacts');
});

for (const fail of ['npm run typecheck', 'node scripts/generate-api-inventory.mjs --check', 'node --test tests/installer-repository.test.mjs', 'npm run lint:all', 'npm run build', 'npm run verify:test-baseline -- --stage=ci --results=jest-results.json', 'npm run verify:test-baseline -- --stage=isolated --results=jest-results-isolated.json', 'npm run validate:mcp-release', 'npm run smoke:mcp-artifacts']) {
  test(`does not authorize publishing when ${fail} fails`, () => {
    assert.throws(() => verifyReleaseRevision(fixture({ fail })), /simulated failed gate/);
  });
}

test('a quarantined Jest exit still requires its fresh baseline gate', () => {
  const f = fixture({ fail: 'npm run test:ci' });
  assert.equal(verifyReleaseRevision(f), sha);
  assert.ok(f.commands.includes('npm run verify:test-baseline -- --stage=ci --results=jest-results.json'));
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
