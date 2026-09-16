import { rmSync } from 'node:fs';

const OFFICIAL_ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)mario-andreschak\/flujo(?:\.git)?\/?$/i;

export function assertOfficialReleaseOrigin(run) {
  for (const command of ['git remote get-url --all origin', 'git remote get-url --push --all origin']) {
    const urls = run(command).trim().split(/\r?\n/);
    if (urls.some((url) => !OFFICIAL_ORIGIN.test(url))) {
      throw new Error('Release origin fetch and push URLs must all target the official FLUJO repository.');
    }
  }
}

/** Run against the version commit itself; previous CI status is not sufficient. */
export function assertVerifiedRevision(run, revision) {
  if (run('git rev-parse HEAD') !== revision || run('git status --porcelain') !== '') {
    throw new Error('Release revision changed or the working tree became dirty after verification. Nothing further may be published.');
  }
  assertOfficialReleaseOrigin(run);
}

export function verifyReleaseRevision({ run, show, removeResults = (file) => rmSync(file, { force: true }) }) {
  const revision = run('git rev-parse HEAD');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Cannot identify the exact release commit.');
  assertVerifiedRevision(run, revision);
  show('npm run typecheck');
  show('node scripts/generate-api-inventory.mjs --check');
  show('npm run lint:all');
  show('node --test scripts/release-arguments.test.mjs scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs');
  show('node --test tests/installer-repository.test.mjs');
  show('npm run build');
  for (const [stage, script, result] of [
    ['ci', 'test:ci', 'jest-results.json'],
    ['isolated', 'test:isolated', 'jest-results-isolated.json'],
  ]) {
    // Never accept an old report if Jest crashes before producing new evidence.
    removeResults(result);
    try { show(`npm run ${script}`); } catch {
      // Known failing assertions may be quarantined. Missing reports, parse
      // failures, unapproved skips and incomplete runs still fail the gate.
    }
    show(`npm run verify:test-baseline -- --stage=${stage} --results=${result}`);
  }
  show('npm run validate:mcp-release');
  show('npm run smoke:mcp-artifacts');
  assertVerifiedRevision(run, revision);
  return revision;
}
