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

export function verifyReleaseRevision({ run, show,
  consumerSmoke = ({ show: output }) => output('npm run smoke:mcp-artifacts') }) {
  const revision = run('git rev-parse HEAD');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Cannot identify the exact release commit.');
  assertVerifiedRevision(run, revision);
  show('npm run typecheck');
  show('npm run typecheck:mcp');
  show('node scripts/generate-api-inventory.mjs --check');
  show('npm run test:dependency-glob');
  show('npm run lint:all');
  show('node --test scripts/verification-contract.test.mjs scripts/workflow-contract.test.mjs scripts/verify-repository-rules.test.mjs scripts/release-arguments.test.mjs scripts/release-verification.test.mjs scripts/require-release-verification.test.mjs scripts/npm-release.test.mjs scripts/release-github.test.mjs scripts/qualify-conversation-recovery.test.mjs');
  show('node --test tests/installer-repository.test.mjs');
  show('node --test scripts/run-local-jest.test.mjs');
  show('node --test scripts/release-evidence.test.mjs');
  show('node --test scripts/local-instance.test.mjs');
  show('node --test scripts/image-release.test.mjs');
  show('npm run build');
  // The Jest suites are deliberately not repeated here. Signing, publication and
  // tagging all require the successful exact-commit verify.yml run, including its
  // test and test-isolated jobs (scripts/require-release-verification.mjs), so a
  // second run on the same revision only added about 14 minutes to every release.
  show('npm run validate:mcp-release');
  consumerSmoke({ run, show, revision });
  assertVerifiedRevision(run, revision);
  return revision;
}
