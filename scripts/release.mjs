#!/usr/bin/env node
// Version locally, verify/publish through GitHub OIDC, then tag and build the
// image and installer. No local npm login or long-lived npm secret is needed.
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parseReleaseArguments, releaseUsage } from './release-arguments.mjs';
import { assertOfficialReleaseOrigin } from './release-verification.mjs';
import { dispatchRelease, landVersionCommit, readReleaseWorkflow, RELEASE_REPOSITORY, resumeRelease, watchRelease } from './release-github.mjs';
import { readReleaseState, writeReleaseState } from './release-state.mjs';

const run = (command) => execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const show = (command) => { console.log(`\n> ${command}`); execSync(command, { stdio: 'inherit' }); };
const gh = (command, args, options = {}) => {
  if (command !== 'gh') throw new Error('Only GitHub CLI commands are accepted here.');
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });
  if (result.error || result.status !== 0) throw result.error ?? new Error(String(result.stderr || `GitHub command failed (${result.status}).`));
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
};
const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(String(result.stderr || `git ${args[0]} failed (${result.status}).`));
  return result.stdout.trim();
};
const SHA = /^[a-f0-9]{40}$/;
const manifestVersion = () => JSON.parse(readFileSync('package.json', 'utf8')).version;

async function main() {
  const { dryRun, bump, help, resume } = parseReleaseArguments(process.argv.slice(2), process.env);
  if (help) { console.log(releaseUsage); return; }
  if (run('git rev-parse --abbrev-ref HEAD') !== 'main') throw new Error('Releases must be cut from main.');
  if (run('git status --porcelain') !== '') throw new Error('The working tree is not clean; commit or stash all changes first.');
  assertOfficialReleaseOrigin(run);

  if (dryRun) {
    show('npm run build');
    show('npm run validate:mcp-release');
    console.log(`\nDry run passed. Would version '${bump}', land its version commit on main through a pull request for exact-revision verification, then publish five tested packages through GitHub OIDC before the version tag, image and installer.`);
    return;
  }
  if (spawnSync('gh', ['--version'], { shell: true, stdio: 'ignore' }).status !== 0) throw new Error('Install and authenticate GitHub CLI to run a release.');
  try { run('gh auth status'); } catch { throw new Error('GitHub CLI authentication failed; run gh auth login.'); }
  readReleaseWorkflow(gh);
  let identity;
  const statePath = run('git rev-parse --git-path flujo-release.json');
  if (resume) {
    identity = resumeRelease({ run: gh, runId: resume, checkoutSha: run('git rev-parse HEAD'), checkoutVersion: manifestVersion() });
  } else {
    console.log('Fetching origin/main and release tags ...');
    run('git fetch origin main "+refs/tags/v*:refs/tags/v*"');
    let state = readReleaseState(statePath);
    if (state) {
      const pendingError = 'A pending release record belongs to another revision. Resolve that release before creating another version.';
      if (!SHA.test(state.sha ?? '') || !/^\d+\.\d+\.\d+$/.test(state.version ?? '')) throw new Error(pendingError);
      // Finish an interrupted landing: the record already names the merged main commit.
      if (state.landed && SHA.test(state.localSha ?? '') && run('git rev-parse HEAD') === state.localSha) show(`git reset --hard ${state.sha}`);
      if (state.sha !== run('git rev-parse HEAD') || state.version !== manifestVersion()) throw new Error(pendingError);
      console.log(`Continuing prepared version ${state.version} without another version bump.`);
    } else {
      if (run('git rev-parse main') !== run('git rev-parse origin/main')) throw new Error('main and origin/main differ; pull or push first.');
      show('npm run build:mcp');
      show(`npm version ${bump} --no-git-tag-version`);
      const version = manifestVersion();
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid synchronized release version.');
      show('git add -u -- src README.md githubpages/index.html mcp-servers package.json package-lock.json');
      show(`git commit -m "Bump version to ${version}"`);
      state = { sha: run('git rev-parse HEAD'), version };
      writeReleaseState(statePath, state, { createOnly: true });
    }
    if (!state.landed) {
      // main accepts changes only through pull requests; release the exact main
      // commit that carries this version change.
      const merged = await landVersionCommit({ git, gh: (args) => gh('gh', args), version: state.version,
        localSha: state.sha, baseSha: git(['rev-parse', `${state.sha}^`]) });
      state = { sha: merged, version: state.version, localSha: state.sha, landed: true };
      writeReleaseState(statePath, state);
      show(`git reset --hard ${merged}`);
    }
    identity = await dispatchRelease({ run: gh, sha: state.sha, version: state.version });
    state.runId = identity.runId;
    writeReleaseState(statePath, state);
  }
  console.log(`\nRelease run: https://github.com/${RELEASE_REPOSITORY}/actions/runs/${identity.runId}`);
  watchRelease({ run: gh, identity });
  const pending = readReleaseState(statePath);
  if (pending) {
    if (pending.sha === identity.sha && pending.version === identity.version) rmSync(statePath);
  }
  console.log(`\nReleased FLUJO ${identity.version}: https://www.npmjs.com/package/flujo-ai/v/${identity.version}`);
  console.log(`GitHub: https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${identity.version}`);
  console.log(`GHCR: ghcr.io/mario-andreschak/flujo:${identity.version}`);
}

main().catch((error) => { console.error(`\nRelease aborted: ${error.message}`); process.exitCode = 1; });
