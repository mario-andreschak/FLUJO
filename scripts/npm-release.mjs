import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { assertVerifiedRevision, verifyReleaseRevision } from './release-verification.mjs';

export const REPOSITORY = 'mario-andreschak/FLUJO';
export const PUBLIC_PACKAGES = [
  '@mario.andreschak/mcp-flujo', '@mario.andreschak/mcp-filesystem',
  '@mario.andreschak/mcp-bash', '@mario.andreschak/mcp-browser', 'flujo-ai',
];
const REGISTRY = 'https://registry.npmjs.org';
const PUBLISHED_INTEGRITY_ATTEMPTS = 31;
const PUBLISHED_INTEGRITY_DELAY_MS = 10_000;
const PUBLISHED_INTEGRITY_TIMEOUT_MS = 5 * 60_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const exec = (command, args, options = {}) => {
  const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, ...options });
  return typeof output === 'string' ? output.trim() : '';
};

export function assertReleaseContext({ env, run, version }) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('npm releases require a manual run on the official main branch.');
  }
  if (!SHA.test(env.RELEASE_SHA ?? '') || env.GITHUB_SHA !== env.RELEASE_SHA
      || run('git', ['rev-parse', 'HEAD']) !== env.RELEASE_SHA) {
    throw new Error('Release checkout and workflow must match the requested exact SHA.');
  }
  if (!VERSION.test(env.RELEASE_VERSION ?? '') || version !== env.RELEASE_VERSION) {
    throw new Error('Release package version does not match the requested version.');
  }
}

export function assertCurrentMain(run, sha) {
  if (!SHA.test(sha) || run('gh', ['api', `repos/${REPOSITORY}/git/ref/heads/main`, '--jq', '.object.sha']) !== sha) {
    throw new Error('Official main moved away from this release; publication refused.');
  }
}

export function readPublishedIntegrity(run, name, version) {
  try {
    // Revalidate even a fresh pre-publication packument. Explicitly disable
    // offline preferences, which npm prioritizes above prefer-online.
    const integrity = JSON.parse(run('npm', ['view', `${name}@${version}`, 'dist.integrity', '--json', '--registry', REGISTRY,
      '--prefer-online', '--prefer-offline=false', '--offline=false', '--fetch-retries=0', '--fetch-timeout=10000'], { timeout: 15_000 }));
    if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) throw new Error(`Invalid registry integrity for ${name}@${version}.`);
    return integrity;
  } catch (error) {
    // Authentication, connectivity and malformed metadata must never look like
    // an unpublished version. npm --json reports E404 through stdout.
    let code;
    try { code = JSON.parse(String(error.stdout)).error?.code; } catch { /* no structured npm error */ }
    if (code === 'E404' || /^npm (?:error|ERR!) code E404\s*$/m.test(String(error.stderr))) return null;
    throw error;
  }
}

const integrityOf = (file) => `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;

export function validateCandidate({ directory, sha, version }) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (!SHA.test(sha) || !VERSION.test(version) || manifest.schemaVersion !== 1
      || manifest.revision !== sha || manifest.version !== version
      || !Array.isArray(manifest.packages) || manifest.packages.length !== PUBLIC_PACKAGES.length) {
    throw new Error('Tested release artifact does not match the requested revision and version.');
  }
  const filenames = new Set();
  for (const [index, item] of manifest.packages.entries()) {
    if (item.name !== PUBLIC_PACKAGES[index] || typeof item.filename !== 'string'
        || !/^[A-Za-z0-9._-]+\.tgz$/.test(item.filename) || filenames.has(item.filename)
        || integrityOf(path.join(directory, item.filename)) !== item.integrity) {
      throw new Error('Tested release tarball names or integrity do not match the artifact manifest.');
    }
    filenames.add(item.filename);
  }
  return manifest;
}

export function prepareCandidate({ run, directory, sha, version }) {
  mkdirSync(directory, { recursive: true });
  const packages = PUBLIC_PACKAGES.map((name) => {
    const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', directory];
    if (name !== 'flujo-ai') args.push('--workspace', name);
    const packed = JSON.parse(run('npm', args));
    if (!Array.isArray(packed) || packed.length !== 1 || packed[0].name !== name || packed[0].version !== version) {
      throw new Error(`Packed package identity does not match ${name}@${version}.`);
    }
    const { filename, integrity } = packed[0];
    return { name, filename, integrity };
  });
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, revision: sha, version, packages }, null, 2)}\n`);
  return validateCandidate({ directory, sha, version });
}

async function confirmPublishedIntegrity({ run, item, version, wait, now }) {
  const deadline = now() + PUBLISHED_INTEGRITY_TIMEOUT_MS;
  for (let attempt = 0; attempt < PUBLISHED_INTEGRITY_ATTEMPTS; attempt++) {
    const integrity = readPublishedIntegrity(run, item.name, version);
    if (integrity === item.integrity) return;
    if (integrity !== null) throw new Error(`Published ${item.name}@${version} did not confirm the tested tarball integrity.`);
    // Only an explicit missing-version response can be propagation delay.
    // Different bytes, authentication, transport and metadata errors stop now.
    const remaining = deadline - now();
    if (remaining <= 0 || attempt + 1 === PUBLISHED_INTEGRITY_ATTEMPTS) break;
    await wait(Math.min(PUBLISHED_INTEGRITY_DELAY_MS, remaining));
  }
  throw new Error(`Published ${item.name}@${version} remains missing after the bounded registry checks. Resume the original release run's failed jobs.`);
}

export async function publishCandidate({ run, directory, sha, version, assertCurrent = () => assertCurrentMain(run, sha), wait = setTimeout, now = () => performance.now() }) {
  const manifest = validateCandidate({ directory, sha, version });
  // Check every existing version before making any new immutable publication.
  const existing = manifest.packages.map((item) => {
    const integrity = readPublishedIntegrity(run, item.name, version);
    if (integrity !== null && integrity !== item.integrity) throw new Error(`Existing ${item.name}@${version} has different bytes; refusing to skip or overwrite it. Resume the original release run's failed jobs.`);
    return integrity;
  });
  const results = [];
  for (const [index, item] of manifest.packages.entries()) {
    assertCurrent();
    if (existing[index] !== null) {
      results.push({ name: item.name, published: false });
      continue;
    }
    run('npm', ['publish', path.join(directory, item.filename), '--access', 'public', '--ignore-scripts', '--registry', REGISTRY], { stdio: 'inherit', timeout: 10 * 60_000 });
    await confirmPublishedIntegrity({ run, item, version, wait, now });
    results.push({ name: item.name, published: true });
  }
  return results;
}

export function assertOidcOnly(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/publish-npm.yml@refs/heads/main`
      || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Publishing requires the configured GitHub-hosted OIDC workflow.');
  }
  if (env.NODE_AUTH_TOKEN || env.NPM_TOKEN) throw new Error('npm write-token fallback is not allowed for this workflow.');
}

async function dispatchAndFind(run, workflow, ref, sha, fields = []) {
  const listArgs = ['run', 'list', '--repo', REPOSITORY, '--workflow', workflow, '--commit', sha,
    '--event', 'workflow_dispatch', '--limit', '20', '--json', 'databaseId,headSha,event'];
  const previous = new Set(JSON.parse(run('gh', listArgs)).map((item) => item.databaseId));
  run('gh', ['workflow', 'run', workflow, '--repo', REPOSITORY, '--ref', ref, ...fields]);
  for (let attempt = 0; attempt < 36; attempt++) {
    const found = JSON.parse(run('gh', listArgs)).filter((item) => item.headSha === sha
      && item.event === 'workflow_dispatch' && !previous.has(item.databaseId))
      .sort((a, b) => b.databaseId - a.databaseId)[0];
    if (found) {
      return found.databaseId;
    }
    await setTimeout(5000);
  }
  throw new Error(`The ${workflow} dispatch did not appear for ${sha}.`);
}

export async function finalizeCandidate({ run, directory, sha, version }) {
  const manifest = validateCandidate({ directory, sha, version });
  for (const item of manifest.packages) {
    if (readPublishedIntegrity(run, item.name, version) !== item.integrity) throw new Error(`Cannot tag before ${item.name}@${version} matches the tested artifact.`);
  }
  assertCurrentMain(run, sha);
  const tag = `v${version}`;
  let existing;
  try { existing = JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/git/ref/tags/${tag}`])).object; } catch (error) {
    if (!/HTTP 404/.test(String(error.stderr))) throw error;
  }
  if (existing?.type === 'tag') existing = JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/git/tags/${existing.sha}`])).object;
  if (existing && (existing.type !== 'commit' || existing.sha !== sha)) throw new Error('Release tag already identifies a different revision.');
  if (!existing) run('gh', ['api', `repos/${REPOSITORY}/git/refs`, '--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${sha}`]);
  // GITHUB_TOKEN-created tags do not trigger push workflows. Explicit manual
  // runs preserve the installer tag gates without another GitHub secret.
  assertCurrentMain(run, sha);
  const runs = await Promise.all([
    dispatchAndFind(run, 'installer.yml', tag, sha),
    dispatchAndFind(run, 'publish-image.yml', 'main', sha, ['-f', `expected_sha=${sha}`, '-f', `expected_version=${version}`]),
  ]);
  for (const id of runs) run('gh', ['run', 'watch', String(id), '--repo', REPOSITORY, '--exit-status', '--interval', '15'], { stdio: 'inherit', timeout: 3 * 60 * 60_000 });
}

async function main() {
  const phase = process.argv[2];
  if (!['check', 'prepare', 'publish', 'finalize'].includes(phase)) throw new Error('Expected check, prepare, publish, or finalize phase.');
  const env = process.env;
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const sha = env.RELEASE_SHA;
  assertReleaseContext({ env, run: exec, version });
  assertCurrentMain(exec, sha);
  if (phase === 'check') return;
  const directory = env.RELEASE_ARTIFACT_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('An absolute release artifact directory is required.');
  if (phase === 'prepare') {
    verifyReleaseRevision({
      run: (command) => execFileSync(command, { shell: true, encoding: 'utf8', timeout: 60_000 }).trim(),
      show: (command) => { console.log(`> ${command}`); execFileSync(command, { shell: true, stdio: 'inherit', timeout: 3 * 60 * 60_000 }); },
      consumerSmoke: ({ revision }) => {
        prepareCandidate({ run: exec, directory, sha: revision, version });
        exec('node', ['scripts/smoke-mcp-artifacts.mjs', '--candidate-dir', directory], { stdio: 'inherit', timeout: 3 * 60 * 60_000 });
      },
    });
    assertCurrentMain(exec, sha);
    assertVerifiedRevision((command) => execFileSync(command, { shell: true, encoding: 'utf8' }).trim(), sha);
  } else if (phase === 'publish') {
    assertOidcOnly(env);
    // A fresh config and empty token environment prevent runner configuration
    // from silently substituting npm credentials if OIDC is misconfigured.
    const config = path.join(env.RUNNER_TEMP, 'flujo-npm-oidc.npmrc');
    const globalConfig = path.join(env.RUNNER_TEMP, 'flujo-npm-global.npmrc');
    writeFileSync(config, `registry=${REGISTRY}\n`);
    writeFileSync(globalConfig, '');
    env.NPM_CONFIG_USERCONFIG = config;
    env.NPM_CONFIG_GLOBALCONFIG = globalConfig;
    await publishCandidate({ run: exec, directory, sha, version });
  } else {
    await finalizeCandidate({ run: exec, directory, sha, version });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Release refused: ${error.message}`); process.exitCode = 1; });
}
