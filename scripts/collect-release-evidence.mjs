// Release evidence collector (#578). For one published version it gathers on
// one page what anyone can check about that release: the exact commit and
// tree, the CI results on that commit, test counts, the npm, Docker image and
// Windows installer checksums with their signed build records (attestations),
// the dependency lists (SBOMs) and the security alerts open when it shipped.
//
// It only reads GitHub, npm registry and container registry data, through
// `gh` and plain HTTPS. It never reads secrets and changes nothing anywhere.
//
//   node scripts/collect-release-evidence.mjs --version 3.48.10            # page to stdout
//   node scripts/collect-release-evidence.mjs --version latest --out docs/quality/release-evidence
//     --out <dir>        write v<version>.md, .json and .answers.json (every answer read)
//     --replay <file>    rebuild from a saved .answers.json instead of the network
//     --skip-npm-bytes   do not download the npm tarballs to hash them
//
// Exit code 2 means two pieces of evidence contradict each other (for example
// a signed build record names another commit). Missing pieces are listed on
// the page but do not fail the run: the page says what is missing and why.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './image-release.mjs';
import { INSTALLER_CHECKSUM_FILE, INSTALLER_EVIDENCE_FILE, INSTALLER_FILE } from './installer-release.mjs';
import { PUBLIC_PACKAGES, RELEASE_INVENTORY_ASSETS, REPOSITORY } from './npm-release.mjs';
import { CHECKSUM_FILE, EVIDENCE_FILE, SBOM_FILE } from './release-evidence.mjs';
import { severityOf } from './security-response-check.mjs';

export const SCHEMA_VERSION = 1;
export const EVIDENCE_DIRECTORY = 'docs/quality/release-evidence';
export const COMMAND = 'npm run evidence:release --';
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const SLSA = 'https://slsa.dev/provenance/v1';
const CYCLONEDX = 'https://cyclonedx.org/bom';
const NPM_PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[a-f0-9]{40}$/;
const SMALL_ASSET_BYTES = 256 * 1024;
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Workflows that build or check a release. `required` ones must pass on the release commit. */
export const RELEASE_WORKFLOWS = Object.freeze([
  { path: '.github/workflows/verify.yml', required: true, role: 'Checks on main: build, tests, types, lint, CodeQL, dependency audit' },
  { path: '.github/workflows/publish-npm.yml', required: true, role: 'Builds, signs and publishes the npm packages' },
  { path: '.github/workflows/publish-image.yml', required: true, role: 'Builds, tests, signs and publishes the Docker image' },
  { path: '.github/workflows/installer.yml', required: true, role: 'Builds, tests on Windows and signs the installer' },
  { path: '.github/workflows/verify-full.yml', required: false, role: 'Full pull-request checks; started by hand' },
  { path: '.github/workflows/scorecard-source.yml', required: false, role: 'Scorecard contract and docs link checks; started by hand' },
]);

/** Jest result files the verify workflow uploads, one per test stage. */
export const TEST_STAGES = Object.freeze([
  { stage: 'ci', artifact: 'jest-results-ci' },
  { stage: 'isolated', artifact: 'jest-results-isolated' },
]);

export const STATUS_LABELS = Object.freeze({
  ok: 'OK', missing: 'Missing', attention: 'Needs attention', mismatch: 'Does not match', 'not-checked': 'Not checked',
});

/** Every question the collector asks. Recording and replay use this list. */
export const SOURCE_METHODS = Object.freeze([
  'latestTag', 'release', 'tagCommit', 'commit', 'mainContains', 'packageVersionAt', 'testBaselineAt', 'runs', 'jobs',
  'artifacts', 'jestSummary', 'releaseAssetText', 'attestations', 'alerts', 'npmVersion', 'npmAttestations', 'hashUrl',
  'imageDigest',
]);

const oneLine = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? 'unknown error';

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)

/** Decode a DSSE envelope payload (base64 JSON) into an in-toto statement. */
export function decodeStatement(payload) {
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

/** Keep only what the page needs from a signed statement. */
export function summarizeStatement(statement) {
  const build = statement?.predicate?.buildDefinition;
  const workflow = build?.externalParameters?.workflow;
  const summary = {
    predicateType: statement?.predicateType ?? null,
    subjects: (statement?.subject ?? []).map((subject) => ({
      name: subject.name, sha256: subject.digest?.sha256 ?? null, sha512: subject.digest?.sha512 ?? null,
    })),
    workflow: workflow ? { repository: workflow.repository ?? null, path: workflow.path ?? null, ref: workflow.ref ?? null } : null,
    commit: build?.resolvedDependencies?.find((dependency) => dependency?.digest?.gitCommit)?.digest.gitCommit ?? null,
    run: statement?.predicate?.runDetails?.metadata?.invocationId ?? null,
    builder: statement?.predicate?.runDetails?.builder?.id ?? null,
  };
  if (summary.predicateType === CYCLONEDX) {
    const bom = statement.predicate ?? {};
    summary.sbom = {
      specVersion: bom.specVersion ?? null,
      root: bom.metadata?.component?.purl ?? bom.metadata?.component?.name ?? null,
      components: Array.isArray(bom.components) ? bom.components.length : 0,
    };
  }
  return summary;
}

/** One alert as the page needs it: severity, when it opened and when it closed. */
export function normalizeAlert(source, alert) {
  return {
    number: alert.number,
    state: alert.state,
    severity: severityOf(source, alert),
    createdAt: alert.created_at ?? null,
    closedAt: alert.fixed_at ?? alert.dismissed_at ?? alert.auto_dismissed_at ?? null,
  };
}

/**
 * Count alerts open at a moment. GitHub keeps only each alert's latest state,
 * so an alert closed at an unknown time is counted as `uncertain`, never hidden.
 */
export function countOpenAlerts(alerts, at) {
  const time = Date.parse(at);
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0, uncertain: 0 };
  for (const alert of alerts) {
    const created = Date.parse(alert.createdAt ?? '');
    if (!(created <= time)) continue;
    if (alert.state !== 'open') {
      const closed = Date.parse(alert.closedAt ?? '');
      if (!Number.isFinite(closed)) { counts.uncertain += 1; continue; }
      if (closed <= time) continue;
    }
    counts[alert.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Keep the counts from a Jest `--json` result file; drop file paths and messages. */
export function summarizeJestResults(results) {
  return {
    suites: {
      total: results.numTotalTestSuites, passed: results.numPassedTestSuites, failed: results.numFailedTestSuites,
      pending: results.numPendingTestSuites, runtimeErrors: results.numRuntimeErrorTestSuites,
    },
    tests: {
      total: results.numTotalTests, passed: results.numPassedTests, failed: results.numFailedTests,
      pending: results.numPendingTests, todo: results.numTodoTests,
    },
    success: results.success === true,
    startedAt: Number.isFinite(results.startTime) ? new Date(results.startTime).toISOString() : null,
  };
}

/** Parse `sha256  filename` lines. */
export function parseChecksums(text) {
  const entries = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *]?(.+)$/.exec(line.trim());
    if (match) entries[match[2]] = match[1];
  }
  return entries;
}

const assetSha256 = (asset) => (/^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? '') ?? [])[1] ?? null;
const integrityHex = (integrity) => {
  const match = /^sha512-(.+)$/.exec(integrity ?? '');
  return match ? Buffer.from(match[1], 'base64').toString('hex') : null;
};

/** Retry short network hiccups with a growing pause; anything else fails at once. */
export async function withRetry(task, { attempts = 3, wait = (ms) => delay(ms) } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const text = `${error?.stderr ?? ''} ${error?.message ?? ''}`;
      const transient = /HTTP (?:429|5\d\d)|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|secondary rate limit/i.test(text);
      if (!transient || attempt >= attempts) throw error;
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Where answers come from: the network, a recording, or a replay

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
      });
  });
}

/** Live answers from GitHub (through `gh`), the npm registry and the container registry. */
export function liveSources({ repository = REPOSITORY, run = runFile, fetchImpl = globalThis.fetch, wait } = {}) {
  const repo = `repos/${repository}`;
  const gh = async (args) => {
    try {
      return await withRetry(() => run('gh', args), { wait });
    } catch (error) {
      if (/HTTP 404/.test(error?.stderr ?? '')) return null;
      const target = args.find((arg) => arg.startsWith('repos/')) ?? args.slice(0, 3).join(' ');
      throw new Error(`gh ${args[0]} ${target}: ${oneLine(error?.stderr || error?.message)}`);
    }
  };
  const ghJson = async (endpoint, jq) => {
    const out = await gh(['api', endpoint, ...(jq ? ['--jq', jq] : [])]);
    return out === null || out.trim() === '' ? null : JSON.parse(out);
  };
  const ghLines = async (endpoint, jq) => {
    const out = await gh(['api', '--paginate', endpoint, '--jq', jq]);
    return out === null ? [] : out.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  };
  const raw = (endpoint) => gh(['api', '-H', 'Accept: application/vnd.github.raw+json', endpoint]);
  const http = (url, init = {}) => withRetry(async () => {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(300_000) });
    if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    return response;
  }, { wait });
  const statements = (payloads) => (payloads ?? []).map((payload) => summarizeStatement(decodeStatement(payload)));

  return {
    latestTag: () => ghJson(`${repo}/releases/latest`, '{tag: .tag_name}').then((answer) => answer?.tag ?? null),
    release: (tag) => ghJson(`${repo}/releases/tags/${tag}`,
      '{tag: .tag_name, name, url: .html_url, publishedAt: .published_at, draft, prerelease, author: .author.login, '
      + 'assets: [.assets[] | {id, name, size, digest}]}'),
    async tagCommit(tag) {
      const object = await ghJson(`${repo}/git/ref/tags/${tag}`, '.object | {sha, type}');
      if (!object) return null;
      if (object.type === 'commit') return { commit: object.sha, annotated: false };
      const target = await ghJson(`${repo}/git/tags/${object.sha}`, '.object | {sha, type}');
      return { commit: target?.type === 'commit' ? target.sha : null, annotated: true };
    },
    commit: (sha) => ghJson(`${repo}/git/commits/${sha}`,
      '{sha, tree: .tree.sha, subject: (.message | split("\\n")[0]), committedAt: .committer.date, '
      + 'verified: .verification.verified, verificationReason: .verification.reason}'),
    mainContains: (sha) => ghJson(`${repo}/compare/${sha}...main`, '{status, aheadBy: .ahead_by, behindBy: .behind_by}'),
    async packageVersionAt(sha) {
      const text = await raw(`${repo}/contents/package.json?ref=${sha}`);
      return text === null ? null : JSON.parse(text).version ?? null;
    },
    async testBaselineAt(sha) {
      const text = await raw(`${repo}/contents/test-baseline.json?ref=${sha}`);
      if (text === null) return null;
      return Object.fromEntries(Object.entries(JSON.parse(text).stages ?? {})
        .map(([stage, floor]) => [stage, { minSuites: floor.minSuites ?? null, minTests: floor.minTests ?? null }]));
    },
    runs: (sha) => ghLines(`${repo}/actions/runs?head_sha=${sha}&per_page=100`,
      '.workflow_runs[] | {id, name, path, event, status, conclusion, createdAt: .created_at, url: .html_url, attempt: .run_attempt} | @json'),
    jobs: (runId) => ghLines(`${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      '.jobs[] | {name, status, conclusion} | @json'),
    artifacts: (runId) => ghLines(`${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      '.artifacts[] | {id, name, size: .size_in_bytes, expired, expiresAt: .expires_at} | @json'),
    async jestSummary(runId, name) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'flujo-release-evidence-'));
      try {
        const out = await gh(['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', directory]);
        if (out === null) return null;
        const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
        if (files.length !== 1) throw new Error(`artifact ${name} holds ${files.length} result files, expected one`);
        return summarizeJestResults(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    releaseAssetText: (assetId) => gh(['api', '-H', 'Accept: application/octet-stream', `${repo}/releases/assets/${assetId}`]),
    attestations: (sha256) => ghJson(`${repo}/attestations/sha256:${sha256}`, '[.attestations[].bundle.dsseEnvelope.payload]')
      .then(statements),
    async alerts(source) {
      const endpoint = source === 'dependabot' ? 'dependabot/alerts' : 'code-scanning/alerts';
      const alerts = await ghLines(`${repo}/${endpoint}?per_page=100`,
        '.[] | {number, state, created_at, fixed_at, dismissed_at, auto_dismissed_at, '
        + 'security_advisory: {severity: .security_advisory.severity}, '
        + 'rule: {security_severity_level: .rule.security_severity_level, severity: .rule.severity}} | @json');
      return alerts.map((alert) => normalizeAlert(source, alert));
    },
    async npmVersion(name, version) {
      const response = await http(`${NPM_REGISTRY}/${name.replace('/', '%2f')}/${version}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`npm registry answered HTTP ${response.status} for ${name}@${version}`);
      const document = await response.json();
      return {
        version: document.version ?? null, integrity: document.dist?.integrity ?? null, tarball: document.dist?.tarball ?? null,
        fileCount: document.dist?.fileCount ?? null, registrySignatures: document.dist?.signatures?.length ?? 0,
        attestationsUrl: document.dist?.attestations?.url ?? null,
      };
    },
    async npmAttestations(url) {
      const response = await http(url);
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`npm registry answered HTTP ${response.status} for its build records`);
      return statements((await response.json()).attestations?.map((item) => item.bundle?.dsseEnvelope?.payload).filter(Boolean));
    },
    async hashUrl(url) {
      const response = await http(url);
      if (!response.ok) throw new Error(`download answered HTTP ${response.status}`);
      const sha256 = createHash('sha256');
      const sha512 = createHash('sha512');
      let bytes = 0;
      for await (const chunk of response.body) {
        sha256.update(chunk);
        sha512.update(chunk);
        bytes += chunk.length;
      }
      return { bytes, sha256: sha256.digest('hex'), integrity: `sha512-${sha512.digest('base64')}` };
    },
    async imageDigest(tag) {
      const [host, ...rest] = IMAGE.split('/');
      const name = rest.join('/');
      const grant = await http(`https://${host}/token?scope=repository:${name}:pull&service=${host}`);
      if (!grant.ok) throw new Error(`${host} gave no anonymous read access (HTTP ${grant.status})`);
      const { token } = await grant.json();
      const response = await http(`https://${host}/v2/${name}/manifests/${encodeURIComponent(tag)}`, {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', '),
        },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${host} answered HTTP ${response.status} for tag ${tag}`);
      return response.headers.get('docker-content-digest');
    },
  };
}

const answerKey = (method, args) => `${method}(${args.map((arg) => JSON.stringify(arg)).join(',')})`;

/** Pass questions through and keep every answer (or error) for a later replay. */
export function recordingSources(sources, answers) {
  return Object.fromEntries(SOURCE_METHODS.map((method) => [method, async (...args) => {
    const key = answerKey(method, args);
    try {
      const value = await sources[method](...args);
      answers[key] = { value: value ?? null };
      return value;
    } catch (error) {
      answers[key] = { error: oneLine(error?.message) };
      throw error;
    }
  }]));
}

/** Answer only from a recording. A question that was never recorded fails loudly. */
export function replaySources(answers) {
  return Object.fromEntries(SOURCE_METHODS.map((method) => [method, async (...args) => {
    const key = answerKey(method, args);
    if (!Object.hasOwn(answers, key)) throw new Error(`No recorded answer for ${key}`);
    if (answers[key].error) throw new Error(answers[key].error);
    return structuredClone(answers[key].value);
  }]));
}

// ---------------------------------------------------------------------------
// Collect

function summarizeJobs(jobs) {
  if (!jobs) return null;
  const failed = jobs.filter((job) => ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(job.conclusion));
  const skipped = jobs.filter((job) => ['skipped', 'neutral'].includes(job.conclusion));
  const unfinished = jobs.filter((job) => job.status !== 'completed');
  return {
    total: jobs.length,
    passed: jobs.filter((job) => job.conclusion === 'success').length,
    failed: failed.map((job) => job.name).sort(),
    skipped: skipped.map((job) => job.name).sort(),
    unfinished: unfinished.map((job) => job.name).sort(),
  };
}

const provenanceOf = (statements) => statements?.find((statement) => statement.predicateType === SLSA) ?? null;
const sbomOf = (statements) => statements?.find((statement) => statement.predicateType === CYCLONEDX)?.sbom ?? null;
const signedBy = (statement) => (statement ? {
  commit: statement.commit, workflow: statement.workflow?.path ?? null, ref: statement.workflow?.ref ?? null,
  repository: statement.workflow?.repository ?? null, run: statement.run, builder: statement.builder,
} : null);

/** Does npm's signed record name the bytes the registry serves? `null` when either side is unknown. */
function namesSameBytes(statement, integrity) {
  const signed = statement?.subjects?.[0]?.sha512;
  const served = integrityHex(integrity);
  return signed && served ? signed === served : null;
}

/**
 * Gather every piece for one release. Each piece that cannot be read is noted
 * in `readErrors` and the rest goes on; only a missing release stops the run.
 */
export async function collectReleaseEvidence({ version, sources, now = new Date(), hashNpmBytes = true }) {
  const readErrors = [];
  const read = async (piece, task, fallback = null) => {
    try {
      return await task();
    } catch (error) {
      readErrors.push({ piece, error: oneLine(error?.message) });
      return fallback;
    }
  };

  let resolved = version;
  if (version === 'latest') {
    const tag = await sources.latestTag();
    resolved = tag?.replace(/^v/, '');
  }
  if (!VERSION.test(resolved ?? '')) throw new Error(`Expected a version like 3.48.10 or "latest", got ${version}.`);
  const tag = `v${resolved}`;
  const release = await sources.release(tag);
  if (!release) throw new Error(`No published GitHub release is named ${tag}.`);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));

  // Source
  const tagged = await read('tag', () => sources.tagCommit(tag));
  const sha = SHA.test(tagged?.commit ?? '') ? tagged.commit : null;
  const commit = sha ? await read('commit', () => sources.commit(sha)) : null;
  const main = sha ? await read('main branch', () => sources.mainContains(sha)) : null;
  const packageVersion = sha ? await read('package.json', () => sources.packageVersionAt(sha)) : null;

  // CI on the exact commit
  const allRuns = sha ? await read('CI runs', () => sources.runs(sha), []) : [];
  const runs = [];
  for (const run of allRuns.filter((item) => RELEASE_WORKFLOWS.some((workflow) => workflow.path === item.path))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const jobs = await read(`jobs of run ${run.id}`, () => sources.jobs(run.id));
    runs.push({ ...run, jobs: summarizeJobs(jobs) });
  }
  const otherRuns = allRuns.filter((item) => !runs.some((run) => run.id === item.id)).map((item) => item.path).sort();

  // Test counts from the verify run on this commit
  const verifyRun = [...runs].reverse().find((run) => run.path === RELEASE_WORKFLOWS[0].path && run.event === 'push') ?? null;
  const artifacts = verifyRun ? await read(`artifacts of run ${verifyRun.id}`, () => sources.artifacts(verifyRun.id), []) : [];
  const baseline = sha ? await read('test-baseline.json', () => sources.testBaselineAt(sha)) : null;
  const tests = [];
  for (const { stage, artifact } of TEST_STAGES) {
    const entry = artifacts.find((item) => item.name === artifact);
    const row = { stage, artifact, run: verifyRun?.id ?? null, floor: baseline?.[stage] ?? null };
    if (!entry) tests.push({ ...row, available: false, reason: verifyRun ? 'not uploaded by the verify run' : 'no verify run on this commit' });
    else if (entry.expired) tests.push({ ...row, available: false, reason: `the result file expired on ${entry.expiresAt?.slice(0, 10)}` });
    else {
      const summary = await read(`test results ${artifact}`, () => sources.jestSummary(verifyRun.id, artifact));
      tests.push(summary ? { ...row, available: true, expiresAt: entry.expiresAt, ...summary }
        : { ...row, available: false, reason: 'the result file could not be read' });
    }
  }

  // npm packages
  const npm = [];
  for (const name of PUBLIC_PACKAGES) {
    const meta = await read(`npm ${name}`, () => sources.npmVersion(name, resolved));
    const npmStatements = meta?.attestationsUrl ? await read(`npm build records of ${name}`, () => sources.npmAttestations(meta.attestationsUrl), []) : [];
    const bytes = hashNpmBytes && meta?.tarball ? await read(`npm tarball of ${name}`, () => sources.hashUrl(meta.tarball)) : null;
    const githubStatements = bytes ? await read(`GitHub build records of ${name}`, () => sources.attestations(bytes.sha256), []) : null;
    const githubProvenance = provenanceOf(githubStatements);
    npm.push({
      name, found: Boolean(meta), version: meta?.version ?? null, integrity: meta?.integrity ?? null,
      fileCount: meta?.fileCount ?? null, registrySignatures: meta?.registrySignatures ?? 0,
      npmPublishRecord: npmStatements.some((statement) => statement.predicateType === NPM_PUBLISH),
      npmProvenance: signedBy(provenanceOf(npmStatements)),
      npmProvenanceDigestMatches: namesSameBytes(provenanceOf(npmStatements), meta?.integrity),
      bytes: bytes ? { size: bytes.bytes, sha256: bytes.sha256, integrityMatches: bytes.integrity === meta?.integrity } : null,
      githubProvenance: signedBy(githubProvenance),
      githubSbom: sbomOf(githubStatements),
      signedFiles: githubProvenance ? Object.fromEntries(githubProvenance.subjects.filter((subject) => !subject.name.endsWith('.tgz'))
        .map((subject) => [subject.name, subject.sha256])) : null,
    });
  }
  const npmInventory = {};
  for (const file of RELEASE_INVENTORY_ASSETS) {
    const asset = assets.get(file);
    npmInventory[file] = asset ? { sha256: assetSha256(asset), size: asset.size } : null;
  }
  const evidenceAsset = assets.get(EVIDENCE_FILE);
  const releaseEvidence = evidenceAsset && evidenceAsset.size <= SMALL_ASSET_BYTES
    ? await read(EVIDENCE_FILE, async () => JSON.parse(await sources.releaseAssetText(evidenceAsset.id))) : null;
  const checksumAsset = assets.get(CHECKSUM_FILE);
  const npmChecksums = checksumAsset && checksumAsset.size <= SMALL_ASSET_BYTES
    ? await read(CHECKSUM_FILE, async () => parseChecksums(await sources.releaseAssetText(checksumAsset.id))) : null;

  // Docker image
  const imageTags = [resolved, ...(sha ? [`sha-${sha.slice(0, 7)}`] : [])];
  const imageDigests = {};
  for (const imageTag of imageTags) imageDigests[imageTag] = await read(`image tag ${imageTag}`, () => sources.imageDigest(imageTag));
  const imageDigest = imageDigests[resolved] ?? null;
  const imageStatements = /^sha256:[a-f0-9]{64}$/.test(imageDigest ?? '')
    ? await read('image build records', () => sources.attestations(imageDigest.slice(7)), []) : null;

  // Windows installer
  const installerAsset = assets.get(INSTALLER_FILE) ?? null;
  const installerSha = assetSha256(installerAsset);
  const installerStatements = installerSha ? await read('installer build records', () => sources.attestations(installerSha), []) : null;
  const installerEvidenceAsset = assets.get(INSTALLER_EVIDENCE_FILE);
  const installerEvidence = installerEvidenceAsset && installerEvidenceAsset.size <= SMALL_ASSET_BYTES
    ? await read(INSTALLER_EVIDENCE_FILE, async () => JSON.parse(await sources.releaseAssetText(installerEvidenceAsset.id))) : null;
  const installerChecksumAsset = assets.get(INSTALLER_CHECKSUM_FILE);
  const installerChecksums = installerChecksumAsset && installerChecksumAsset.size <= SMALL_ASSET_BYTES
    ? await read(INSTALLER_CHECKSUM_FILE, async () => parseChecksums(await sources.releaseAssetText(installerChecksumAsset.id))) : null;

  // Security alerts, then and now
  const alerts = {};
  for (const source of ['code-scanning', 'dependabot']) {
    const list = await read(`${source} alerts`, () => sources.alerts(source));
    alerts[source] = list ? { atRelease: countOpenAlerts(list, release.publishedAt), now: countOpenAlerts(list, now.toISOString()) } : null;
  }

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    repository: REPOSITORY,
    version: resolved,
    tag,
    collectedAt: now.toISOString(),
    command: `${COMMAND} --version ${resolved} --out ${EVIDENCE_DIRECTORY}`,
    options: { hashNpmBytes },
    release: {
      url: release.url, publishedAt: release.publishedAt, draft: release.draft, prerelease: release.prerelease,
      author: release.author, assets: release.assets.map(({ name, size, digest }) => ({ name, size, digest: digest ?? null })),
    },
    source: {
      commit: sha, annotatedTag: tagged?.annotated ?? null, tree: commit?.tree ?? null, subject: commit?.subject ?? null,
      committedAt: commit?.committedAt ?? null, signatureVerified: commit?.verified ?? null,
      signatureReason: commit?.verificationReason ?? null, main, packageVersion,
    },
    ci: { runs, otherRuns },
    tests,
    npm,
    npmInventory: { assets: npmInventory, evidence: releaseEvidence ? {
      revision: releaseEvidence.revision ?? null, version: releaseEvidence.version ?? null,
      artifacts: (releaseEvidence.artifacts ?? []).map(({ name, sha256 }) => ({ name, sha256 })),
      sbomSha256: releaseEvidence.sbom?.sha256 ?? null,
    } : null, checksums: npmChecksums },
    image: {
      name: IMAGE, digests: imageDigests, digest: imageDigest,
      provenance: signedBy(provenanceOf(imageStatements)), sbom: sbomOf(imageStatements),
      recordsFound: imageStatements?.length ?? null,
    },
    installer: {
      asset: installerAsset ? { name: installerAsset.name, size: installerAsset.size, sha256: installerSha } : null,
      evidence: installerEvidence ? {
        revision: installerEvidence.revision ?? null, version: installerEvidence.version ?? null, ref: installerEvidence.ref ?? null,
        sha256: installerEvidence.artifact?.sha256 ?? null, size: installerEvidence.artifact?.size ?? null,
      } : null,
      checksums: installerChecksums,
      evidenceSha256: assetSha256(installerEvidenceAsset),
      provenance: signedBy(provenanceOf(installerStatements)),
    },
    alerts,
    readErrors,
  };
  evidence.checks = assessEvidence(evidence);
  return evidence;
}

// ---------------------------------------------------------------------------
// Judge each piece: OK, missing, needs attention, does not match, not checked

const short = (sha) => (sha ? sha.slice(0, 8) : 'unknown');
// A job skipped before its matrix expands keeps "(${{ matrix.os }})" in its name.
const jobNames = (names) => names.map((name) => name.replace(/\s*\(\$\{\{.*?\}\}\)/g, '')).join(', ');
const errorFor = (evidence, pattern) => evidence.readErrors.find((item) => pattern.test(item.piece))?.error;

function signedCheck(evidence, id, piece, signer, workflow, { refPattern = /^refs\/heads\/main$/ } = {}) {
  const commit = evidence.source.commit;
  if (!signer) return { id, piece, status: 'missing', detail: 'No signed build record (provenance) was found for these bytes.' };
  const problems = [];
  if (signer.commit !== commit) problems.push(`it names commit ${short(signer.commit)}, the release is ${short(commit)}`);
  if (signer.workflow !== workflow) problems.push(`it names workflow ${signer.workflow ?? 'none'}, expected ${workflow}`);
  if (signer.repository !== REPOSITORY_URL) problems.push(`it names repository ${signer.repository ?? 'none'}`);
  if (!refPattern.test(signer.ref ?? '')) problems.push(`it was built from ${signer.ref ?? 'an unknown ref'}`);
  if (problems.length) return { id, piece, status: 'mismatch', detail: `The signed build record does not fit: ${problems.join('; ')}.` };
  return { id, piece, status: 'ok', detail: `Signed build record from ${workflow} at ${signer.ref} names commit ${short(commit)}.` };
}

export function assessEvidence(evidence) {
  const checks = [];
  const add = (id, piece, status, detail) => checks.push({ id, piece, status, detail });
  const { source, release } = evidence;
  const commit = source.commit;

  add('release', 'GitHub release', release.draft || release.prerelease ? 'attention' : 'ok',
    `${evidence.tag} published ${when(release.publishedAt)}${release.draft ? ' (draft)' : ''}${release.prerelease ? ' (pre-release)' : ''}.`);

  if (!commit) add('source-commit', 'Exact commit and tree', 'not-checked', `The tag could not be resolved: ${errorFor(evidence, /^tag$/) ?? 'no commit'}.`);
  else if (!source.tree) add('source-commit', 'Exact commit and tree', 'not-checked', `Commit ${short(commit)} found, tree unknown: ${errorFor(evidence, /^commit$/) ?? 'no answer'}.`);
  else add('source-commit', 'Exact commit and tree', 'ok', `Tag ${evidence.tag} points to commit ${short(commit)}, tree ${short(source.tree)}.`);

  if (source.main) {
    const onMain = ['ahead', 'identical'].includes(source.main.status);
    add('source-main', 'Commit is on main', onMain ? 'ok' : 'mismatch',
      onMain ? `main contains the commit (${source.main.aheadBy} newer commits since).` : `main does not contain the commit (compare status ${source.main.status}).`);
  } else if (commit) add('source-main', 'Commit is on main', 'not-checked', errorFor(evidence, /^main branch$/) ?? 'No answer.');

  if (source.packageVersion !== null && source.packageVersion !== undefined) {
    add('source-version', 'package.json version', source.packageVersion === evidence.version ? 'ok' : 'mismatch',
      `package.json at the commit says ${source.packageVersion}.`);
  } else if (commit) add('source-version', 'package.json version', 'not-checked', errorFor(evidence, /^package\.json$/) ?? 'No answer.');

  if (source.signatureVerified !== null && source.signatureVerified !== undefined) {
    add('source-signature', 'Commit signature', source.signatureVerified ? 'ok' : 'missing',
      source.signatureVerified ? `GitHub shows the commit signature as verified (${source.signatureReason}).`
        : `GitHub shows no verified signature (${source.signatureReason ?? 'unsigned'}).`);
  }

  const ciError = errorFor(evidence, /^CI runs$/);
  for (const workflow of RELEASE_WORKFLOWS) {
    const id = `ci-${path.posix.basename(workflow.path, '.yml')}`;
    const piece = `CI: ${path.posix.basename(workflow.path)}`;
    const matching = evidence.ci.runs.filter((run) => run.path === workflow.path);
    const run = matching.at(-1);
    if (ciError) add(id, piece, 'not-checked', ciError);
    else if (!run) add(id, piece, 'missing', `Did not run on this commit${workflow.required ? '' : ' (optional; started by hand)'}.`);
    else {
      const jobs = run.jobs;
      const jobText = jobs ? `${jobs.passed} of ${jobs.total} jobs passed${jobs.failed.length ? `, failed: ${jobNames(jobs.failed)}` : ''}`
        + `${jobs.skipped.length ? `, skipped: ${jobNames(jobs.skipped)}` : ''}` : 'jobs not read';
      const attempt = run.attempt > 1 ? `, attempt ${run.attempt}` : '';
      const good = run.conclusion === 'success' && (!jobs || jobs.failed.length === 0);
      add(id, piece, good ? 'ok' : 'attention', `${run.conclusion ?? run.status} (${run.event}${attempt}); ${jobText}.`);
    }
  }

  for (const stage of evidence.tests) {
    const piece = `Tests: ${stage.stage} stage`;
    if (!stage.available) { add(`tests-${stage.stage}`, piece, 'missing', `No counts: ${stage.reason}.`); continue; }
    const belowFloor = stage.floor && (stage.suites.total < stage.floor.minSuites || stage.tests.total < stage.floor.minTests);
    const status = stage.tests.failed === 0 && stage.suites.failed === 0 && !belowFloor ? 'ok' : 'attention';
    add(`tests-${stage.stage}`, piece, status,
      `${stage.tests.passed} of ${stage.tests.total} tests passed in ${stage.suites.total} suites; ${stage.tests.failed} failed, `
      + `${stage.tests.pending + stage.tests.todo} skipped${stage.floor ? `; floor ${stage.floor.minTests} tests` : ''}.`);
  }

  const npmMissing = evidence.npm.filter((item) => !item.found).map((item) => item.name);
  add('npm-registry', 'npm packages on the registry', npmMissing.length ? 'missing' : 'ok',
    npmMissing.length ? `Not found: ${npmMissing.join(', ')}.` : `All ${evidence.npm.length} packages exist at ${evidence.version} with an integrity hash and ${Math.min(...evidence.npm.map((item) => item.registrySignatures))}+ registry signatures.`);

  const found = evidence.npm.filter((item) => item.found);
  const npmProvenance = found.map((item) => signedCheck(evidence, 'npm-provenance', 'npm provenance', item.npmProvenance, '.github/workflows/publish-npm.yml'));
  const digestMismatch = found.filter((item) => item.npmProvenanceDigestMatches === false).map((item) => item.name);
  if (digestMismatch.length) add('npm-provenance', 'npm provenance', 'mismatch', `The signed record names other bytes for: ${digestMismatch.join(', ')}.`);
  else checks.push(worst('npm-provenance', 'npm provenance', npmProvenance, `All ${found.length} packages carry npm provenance from publish-npm.yml naming commit ${short(commit)}.`));

  if (!evidence.options.hashNpmBytes) {
    add('npm-bytes', 'npm tarball bytes', 'not-checked', 'Skipped with --skip-npm-bytes.');
  } else {
    const unread = found.filter((item) => !item.bytes).map((item) => item.name);
    const differ = found.filter((item) => item.bytes && !item.bytes.integrityMatches).map((item) => item.name);
    if (differ.length) add('npm-bytes', 'npm tarball bytes', 'mismatch', `Downloaded bytes differ from the registry's integrity hash: ${differ.join(', ')}.`);
    else if (unread.length) add('npm-bytes', 'npm tarball bytes', 'not-checked', `Could not download: ${unread.join(', ')}.`);
    else add('npm-bytes', 'npm tarball bytes', 'ok', `Downloaded all ${found.length} tarballs (${found.reduce((sum, item) => sum + item.bytes.size, 0)} bytes); each matches its registry integrity hash.`);

    const hashed = found.filter((item) => item.bytes);
    const records = hashed.map((item) => signedCheck(evidence, 'npm-github-provenance', 'GitHub build record for npm bytes', item.githubProvenance, '.github/workflows/publish-npm.yml'));
    if (hashed.length) checks.push(worst('npm-github-provenance', 'GitHub build record for npm bytes', records, `GitHub holds a signed build record for each tarball, from publish-npm.yml at commit ${short(commit)}.`));
    const noSbom = hashed.filter((item) => !item.githubSbom).map((item) => item.name);
    const sbom = hashed.find((item) => item.githubSbom)?.githubSbom;
    if (hashed.length) {
      add('npm-sbom-signed', 'npm dependency list (SBOM), signed', noSbom.length ? 'missing' : 'ok',
        noSbom.length ? `No signed SBOM for: ${noSbom.join(', ')}.` : `Signed CycloneDX ${sbom.specVersion} list for ${sbom.root}, ${sbom.components} components.`);
    }
  }

  const inventory = evidence.npmInventory;
  const missingAssets = RELEASE_INVENTORY_ASSETS.filter((file) => !inventory.assets[file]);
  if (missingAssets.length) {
    const signedSbom = evidence.npm.find((item) => item.signedFiles?.[SBOM_FILE])?.signedFiles[SBOM_FILE];
    add('npm-sbom-release', 'npm SBOM and checksums on the release page', 'missing',
      `Not attached: ${missingAssets.join(', ')}. Releases made before the release workflow attached them (#565) keep them only in `
      + `GitHub's signed store and the 30-day workflow artifact.${signedSbom ? ` The signed npm build record still names the SBOM's SHA-256 (${signedSbom.slice(0, 12)}...).` : ''}`);
  } else {
    const problems = [];
    const record = inventory.evidence;
    if (!record) problems.push(`${EVIDENCE_FILE} could not be read`);
    else {
      if (record.revision !== commit) problems.push(`${EVIDENCE_FILE} names commit ${short(record.revision)}`);
      if (record.version !== evidence.version) problems.push(`${EVIDENCE_FILE} names version ${record.version}`);
      if (record.sbomSha256 !== inventory.assets[SBOM_FILE].sha256) problems.push(`the attached SBOM differs from the one ${EVIDENCE_FILE} lists`);
      for (const item of evidence.npm.filter((entry) => entry.bytes)) {
        const listed = record.artifacts.find((artifact) => artifact.name === item.name)?.sha256;
        if (listed !== item.bytes.sha256) problems.push(`${item.name} registry bytes differ from ${EVIDENCE_FILE}`);
      }
    }
    for (const file of [EVIDENCE_FILE, SBOM_FILE]) {
      const listed = inventory.checksums?.[file];
      if (listed && listed !== inventory.assets[file].sha256) problems.push(`${CHECKSUM_FILE} lists another hash for ${file}`);
      const signed = evidence.npm.find((item) => item.signedFiles?.[file])?.signedFiles[file];
      if (signed && signed !== inventory.assets[file].sha256) problems.push(`the signed build record lists another hash for ${file}`);
    }
    add('npm-sbom-release', 'npm SBOM and checksums on the release page', problems.length ? 'mismatch' : 'ok',
      problems.length ? `${problems.join('; ')}.` : `${RELEASE_INVENTORY_ASSETS.join(', ')} are attached and agree with each other and the registry bytes.`);
  }

  const image = evidence.image;
  const digests = Object.entries(image.digests);
  if (!image.digest) add('image-digest', 'Docker image', 'missing', `No image tagged ${evidence.version}${errorFor(evidence, /^image tag/) ? `: ${errorFor(evidence, /^image tag/)}` : ''}.`);
  else {
    const others = digests.filter(([, digest]) => digest && digest !== image.digest).map(([tagName]) => tagName);
    add('image-digest', 'Docker image', others.length ? 'mismatch' : 'ok',
      others.length ? `Tags ${others.join(', ')} point to other bytes than ${evidence.version}.` : `${digests.filter(([, digest]) => digest).map(([tagName]) => tagName).join(' and ')} point to ${image.digest.slice(0, 19)}...`);
    checks.push(signedCheck(evidence, 'image-provenance', 'Docker image build record', image.provenance, '.github/workflows/publish-image.yml'));
    add('image-sbom', 'Docker image dependency list (SBOM), signed', image.sbom ? 'ok' : 'missing',
      image.sbom ? `Signed CycloneDX ${image.sbom.specVersion} list of the image's OS and installed packages, ${image.sbom.components} components.` : 'No signed SBOM on the image digest.');
  }

  const installer = evidence.installer;
  if (!installer.asset) add('installer-asset', 'Windows installer', 'missing', `${INSTALLER_FILE} is not attached to the release.`);
  else {
    const problems = [];
    if (!installer.asset.sha256) problems.push('GitHub shows no checksum for the attached file');
    if (installer.evidence) {
      if (installer.evidence.revision !== commit) problems.push(`${INSTALLER_EVIDENCE_FILE} names commit ${short(installer.evidence.revision)}`);
      if (installer.evidence.version !== evidence.version) problems.push(`${INSTALLER_EVIDENCE_FILE} names version ${installer.evidence.version}`);
      if (installer.evidence.sha256 !== installer.asset.sha256) problems.push(`${INSTALLER_EVIDENCE_FILE} lists other bytes`);
    }
    if (installer.checksums) {
      if (installer.checksums[INSTALLER_FILE] !== installer.asset.sha256) problems.push(`${INSTALLER_CHECKSUM_FILE} lists other bytes for ${INSTALLER_FILE}`);
      if (installer.evidenceSha256 && installer.checksums[INSTALLER_EVIDENCE_FILE] !== installer.evidenceSha256) problems.push(`${INSTALLER_CHECKSUM_FILE} lists another hash for ${INSTALLER_EVIDENCE_FILE}`);
    }
    const missing = [!installer.evidence && INSTALLER_EVIDENCE_FILE, !installer.checksums && INSTALLER_CHECKSUM_FILE].filter(Boolean);
    const status = problems.length ? 'mismatch' : missing.length ? 'missing' : 'ok';
    add('installer-asset', 'Windows installer', status, problems.length ? `${problems.join('; ')}.`
      : missing.length ? `${INSTALLER_FILE} is attached, but not ${missing.join(' or ')}.`
        : `${INSTALLER_FILE} (${installer.asset.size} bytes) matches ${INSTALLER_EVIDENCE_FILE} and ${INSTALLER_CHECKSUM_FILE}.`);
    if (installer.asset.sha256) {
      checks.push(signedCheck(evidence, 'installer-provenance', 'Windows installer build record', installer.provenance, '.github/workflows/installer.yml',
        { refPattern: new RegExp(`^refs/(?:heads/main|tags/${evidence.tag.replace(/\./g, '\\.')})$`) }));
    }
  }
  add('installer-code-signing', 'Windows code signing (Authenticode)', 'not-checked', 'This collector does not open the installer file; check it on Windows (see "How to check this yourself").');

  for (const sourceName of ['code-scanning', 'dependabot']) {
    const counts = evidence.alerts[sourceName];
    const piece = `Open ${sourceName === 'dependabot' ? 'dependency' : 'code scanning'} alerts at release`;
    if (!counts) { add(`alerts-${sourceName}`, piece, 'not-checked', errorFor(evidence, new RegExp(`^${sourceName} alerts$`)) ?? 'No answer.'); continue; }
    const serious = counts.atRelease.critical + counts.atRelease.high;
    add(`alerts-${sourceName}`, piece, serious ? 'attention' : 'ok',
      `${counts.atRelease.total} open (${counts.atRelease.critical} critical, ${counts.atRelease.high} high); ${counts.now.total} open on ${evidence.collectedAt.slice(0, 10)}.`);
  }
  return checks;
}

function worst(id, piece, results, okDetail) {
  for (const status of ['mismatch', 'missing', 'attention', 'not-checked']) {
    const hit = results.find((result) => result.status === status);
    if (hit) return { id, piece, status, detail: hit.detail };
  }
  return { id, piece, status: results.length ? 'ok' : 'missing', detail: results.length ? okDetail : 'Nothing to check.' };
}

// ---------------------------------------------------------------------------
// Render the page (a pure function of the JSON, so the page can be re-checked)

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'unknown');
const commitLink = (repository, sha) => (sha ? `[\`${sha.slice(0, 12)}\`](https://github.com/${repository}/commit/${sha})` : 'unknown');
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');

export function renderEvidencePage(evidence) {
  const { repository, source } = evidence;
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [status, evidence.checks.filter((check) => check.status === status).length]));
  const gaps = evidence.checks.filter((check) => check.status !== 'ok');
  const lines = [
    `# Release evidence: FLUJO ${evidence.version}`,
    '',
    `<!-- Generated by scripts/collect-release-evidence.mjs from v${evidence.version}.json. Do not edit by hand: run the command below again. -->`,
    '',
    `Collected on ${when(evidence.collectedAt)} from public GitHub, npm registry and container`,
    'registry data. This page records facts about one published release. It awards no',
    'grade; the [reassessment package](../independent-reassessment.md) explains how an',
    'outside reviewer uses it.',
    '',
    `Re-create it: \`${evidence.command}\``,
    '',
    '## Summary',
    '',
    `${counts.ok} OK, ${counts.missing} missing, ${counts.attention} need attention, ${counts.mismatch} do not match, ${counts['not-checked']} not checked.`,
    '',
    table(['Piece', 'Result', 'Detail'], evidence.checks.map((check) => [check.piece, STATUS_LABELS[check.status], check.detail])),
    '',
    '## Source',
    '',
    `- Release: [${evidence.tag}](${evidence.release.url}), published ${when(evidence.release.publishedAt)} by \`${evidence.release.author}\``,
    `- Commit: ${commitLink(repository, source.commit)} (${source.annotatedTag ? 'annotated' : 'lightweight'} tag)`,
    `- Full commit: \`${source.commit ?? 'unknown'}\``,
    `- Tree: \`${source.tree ?? 'unknown'}\`${source.commit ? ` ([browse the files](https://github.com/${repository}/tree/${source.commit}), [changelog](https://github.com/${repository}/blob/${source.commit}/CHANGELOG.md))` : ''}`,
    `- Commit message: ${source.subject ?? 'unknown'} (${when(source.committedAt)})`,
    `- Signature: ${source.signatureVerified === true ? `verified by GitHub (${source.signatureReason})` : source.signatureVerified === false ? `not verified (${source.signatureReason})` : 'unknown'}`,
    `- On main: ${source.main ? (['ahead', 'identical'].includes(source.main.status) ? `yes, ${source.main.aheadBy} newer commits on main since` : `no (${source.main.status})`) : 'unknown'}`,
    `- Version in package.json at this commit: ${source.packageVersion ?? 'unknown'}`,
    '',
    '## CI on this exact commit',
    '',
    table(['Workflow', 'Trigger', 'Result', 'Jobs', 'Run'], evidence.ci.runs.map((run) => [
      path.posix.basename(run.path), `${run.event}${run.attempt > 1 ? `, attempt ${run.attempt}` : ''}`, run.conclusion ?? run.status,
      run.jobs ? `${run.jobs.passed}/${run.jobs.total} passed${run.jobs.failed.length ? `; failed: ${jobNames(run.jobs.failed)}` : ''}${run.jobs.skipped.length ? `; skipped: ${jobNames(run.jobs.skipped)}` : ''}` : 'not read',
      `[${run.id}](${run.url})`,
    ])),
    '',
    `Workflows that did not run on this commit: ${RELEASE_WORKFLOWS.filter((workflow) => !evidence.ci.runs.some((run) => run.path === workflow.path)).map((workflow) => `\`${path.posix.basename(workflow.path)}\` (${workflow.role})`).join(', ') || 'none'}.`,
    `Other runs on this commit, not part of a release: ${evidence.ci.otherRuns.length ? [...new Set(evidence.ci.otherRuns)].map((item) => `\`${item}\``).join(', ') : 'none'}.`,
    '',
    '## Tests',
    '',
    table(['Stage', 'Suites', 'Tests passed', 'Failed', 'Skipped', 'Floor in test-baseline.json', 'Source'], evidence.tests.map((stage) => stage.available
      ? [stage.stage, stage.suites.total, `${stage.tests.passed} of ${stage.tests.total}`, stage.tests.failed, stage.tests.pending + stage.tests.todo,
        stage.floor ? `${stage.floor.minSuites} suites, ${stage.floor.minTests} tests` : 'none', `\`${stage.artifact}\` from run ${stage.run}`]
      : [stage.stage, '-', '-', '-', '-', stage.floor ? `${stage.floor.minSuites} suites, ${stage.floor.minTests} tests` : 'none', `not available: ${stage.reason}`])),
    '',
    'These are source tests run by CI on the release commit. They do not test the',
    'installed packages, the image or the installer.',
    '',
    '## npm packages',
    '',
    table(['Package', 'Integrity (SHA-512)', 'Tarball SHA-256', 'npm provenance', 'GitHub build record', 'Signed SBOM'], evidence.npm.map((item) => [
      `[${item.name}](https://www.npmjs.com/package/${item.name}/v/${evidence.version})`,
      item.integrity ? `\`${item.integrity.slice(0, 27)}...\`` : 'not found',
      item.bytes ? `\`${item.bytes.sha256.slice(0, 16)}...\`${item.bytes.integrityMatches ? '' : ' (differs)'}` : 'not downloaded',
      item.npmProvenance ? `${short(item.npmProvenance.commit)}, ${path.posix.basename(item.npmProvenance.workflow ?? '')}` : 'none',
      item.githubProvenance ? `${short(item.githubProvenance.commit)}, ${path.posix.basename(item.githubProvenance.workflow ?? '')}` : item.bytes ? 'none' : 'not checked',
      item.githubSbom ? `${item.githubSbom.components} components` : item.bytes ? 'none' : 'not checked',
    ])),
    '',
    `Release page files: ${RELEASE_INVENTORY_ASSETS.map((file) => `\`${file}\` ${evidence.npmInventory.assets[file] ? 'attached' : 'not attached'}`).join(', ')}.`,
    ...(() => {
      const signedFiles = evidence.npm.find((item) => item.signedFiles)?.signedFiles;
      return signedFiles ? ['', 'Files listed in the signed npm build record (SHA-256):', '',
        ...Object.entries(signedFiles).sort(([a], [b]) => a.localeCompare(b)).map(([file, sha]) => `- \`${file}\`: \`${sha}\``)] : [];
    })(),
    '',
    '## Docker image',
    '',
    `- Image: \`${evidence.image.name}\``,
    ...Object.entries(evidence.image.digests).map(([tagName, digest]) => `- Tag \`${tagName}\`: ${digest ? `\`${digest}\`` : 'not found'}`),
    `- Build record: ${evidence.image.provenance ? `commit ${short(evidence.image.provenance.commit)}, ${evidence.image.provenance.workflow} at ${evidence.image.provenance.ref}` : 'none found'}`,
    `- Signed SBOM: ${evidence.image.sbom ? `CycloneDX ${evidence.image.sbom.specVersion}, ${evidence.image.sbom.components} components` : 'none found'}`,
    '',
    '## Windows installer',
    '',
    `- File: ${evidence.installer.asset ? `\`${evidence.installer.asset.name}\`, ${evidence.installer.asset.size} bytes, SHA-256 \`${evidence.installer.asset.sha256}\`` : 'not attached'}`,
    `- \`${INSTALLER_EVIDENCE_FILE}\`: ${evidence.installer.evidence ? `commit ${short(evidence.installer.evidence.revision)}, version ${evidence.installer.evidence.version}, built from ${evidence.installer.evidence.ref}` : 'not attached or not readable'}`,
    `- Build record: ${evidence.installer.provenance ? `commit ${short(evidence.installer.provenance.commit)}, ${evidence.installer.provenance.workflow} at ${evidence.installer.provenance.ref}` : 'none found'}`,
    '- Dependency list: the installer downloads the npm application above, so the npm SBOM lists what it installs.',
    '',
    '## Security alerts',
    '',
    table(['Alerts', 'When', 'Critical', 'High', 'Medium', 'Low', 'Total'], ['code-scanning', 'dependabot'].flatMap((sourceName) => {
      const label = sourceName === 'dependabot' ? 'Dependency (Dependabot)' : 'Code scanning (CodeQL)';
      const value = evidence.alerts[sourceName];
      if (!value) return [[label, 'not readable', '-', '-', '-', '-', '-']];
      return [[label, `open at release (${when(evidence.release.publishedAt)})`, ...SEVERITIES.map((severity) => value.atRelease[severity]), value.atRelease.total],
        [label, `open on ${evidence.collectedAt.slice(0, 10)}`, ...SEVERITIES.map((severity) => value.now[severity]), value.now.total]];
    })),
    '',
    'The counts at release are rebuilt from each alert\'s opening and closing dates,',
    'because GitHub keeps only the latest state of an alert. Written reasons for each',
    'open alert are in [alert-triage.json](../../security/alert-triage.json) and the',
    'process is in [vulnerability response](../../security/vulnerability-response.md).',
    ...Object.entries(evidence.alerts).filter(([, value]) => value?.atRelease.uncertain)
      .map(([sourceName, value]) => `${value.atRelease.uncertain} closed ${sourceName} alerts have no closing date and are left out of the count at release.`),
    '',
    '## Missing or not checked',
    '',
    ...(gaps.length ? gaps.map((check) => `- **${check.piece}** (${STATUS_LABELS[check.status]}): ${check.detail}`) : ['Nothing.']),
    ...(evidence.readErrors.length ? ['', 'Pieces that could not be read:', '', ...evidence.readErrors.map((item) => `- ${item.piece}: ${item.error}`)] : []),
    '',
    '## How to check this yourself',
    '',
    'Each command reads public data and changes nothing. Use the full commit above.',
    '',
    '```sh',
    `gh release view ${evidence.tag} --repo ${repository}`,
    `npm view flujo-ai@${evidence.version} dist`,
    `npm audit signatures   # inside a project that installed flujo-ai@${evidence.version}`,
    `gh attestation verify oci://${evidence.image.name}:${evidence.version} --repo ${repository} --signer-workflow ${repository}/.github/workflows/publish-image.yml --source-digest ${source.commit ?? '<commit>'} --deny-self-hosted-runners`,
    `gh release download ${evidence.tag} --repo ${repository} --pattern ${INSTALLER_FILE}`,
    `gh attestation verify ${INSTALLER_FILE} --repo ${repository} --signer-workflow ${repository}/.github/workflows/installer.yml --source-digest ${source.commit ?? '<commit>'} --deny-self-hosted-runners`,
    `npm pack flujo-ai@${evidence.version}`,
    `gh attestation verify flujo-ai-${evidence.version}.tgz --repo ${repository} --signer-workflow ${repository}/.github/workflows/publish-npm.yml --source-digest ${source.commit ?? '<commit>'} --deny-self-hosted-runners`,
    '```',
    '',
    `On Windows, \`Get-AuthenticodeSignature .\\${INSTALLER_FILE}\` shows whether the installer is code-signed.`,
    'The full steps are in [release distribution verification](../../release-distribution-verification.md).',
    '',
    '## What this page does not prove',
    '',
    '- It reads the signed build records from GitHub\'s and npm\'s stores and checks the',
    '  commit, workflow and file hashes they name. It does not check the cryptographic',
    '  signatures themselves; the commands above do.',
    '- CI and test results are for the source on the release commit. Installing and',
    '  using the npm package, the image or the installer is a separate check (#570, #572).',
    '- It says nothing about real users, long real-model runs, or human use (#577, and',
    '  the targets in the [scorecard foundation contract](../scorecard-foundation.md)).',
    '- Alert counts need a GitHub login with access to the repository\'s security alerts.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Command line

function parseArguments(argv) {
  const options = { hashNpmBytes: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--skip-npm-bytes') { options.hashNpmBytes = false; continue; }
    const key = { '--version': 'version', '--out': 'out', '--replay': 'replay' }[flag];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error('Usage: collect-release-evidence.mjs --version <x.y.z|latest> [--out <dir>] [--replay <answers file>] [--skip-npm-bytes]');
    }
    options[key] = value;
    index += 1;
  }
  if (!options.version) throw new Error('Missing --version <x.y.z|latest>.');
  return options;
}

export const answersFile = (directory, version) => path.join(directory, `v${version}.answers.json`);

/** One answer per line keeps recordings small and their diffs readable. */
export function formatRecording(recording) {
  const { answers, ...head } = recording;
  const entries = Object.keys(answers).sort().map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(answers[key])}`);
  const headText = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${headText},\n  "answers": {\n${entries.join(',\n')}\n  }\n}\n`;
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const options = parseArguments(argv);
  let sources;
  let now = new Date();
  let answers = null;
  if (options.replay) {
    const recording = JSON.parse(await readFile(options.replay, 'utf8'));
    sources = replaySources(recording.answers);
    now = new Date(recording.collectedAt);
    options.hashNpmBytes = recording.options?.hashNpmBytes ?? options.hashNpmBytes;
  } else {
    answers = {};
    sources = recordingSources(liveSources(), answers);
  }
  const evidence = await collectReleaseEvidence({ version: options.version, sources, now, hashNpmBytes: options.hashNpmBytes });
  const page = renderEvidencePage(evidence);
  if (options.out) {
    // The answers file keeps the raw facts the page was built from, so anyone
    // can rebuild the page offline with --replay and see that nothing was edited.
    await mkdir(options.out, { recursive: true });
    await writeFile(path.join(options.out, `v${evidence.version}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(path.join(options.out, `v${evidence.version}.md`), page);
    if (answers) {
      await writeFile(answersFile(options.out, evidence.version), formatRecording({
        schemaVersion: SCHEMA_VERSION, version: evidence.version, collectedAt: evidence.collectedAt,
        options: { hashNpmBytes: options.hashNpmBytes }, answers,
      }));
    }
    log(`Wrote v${evidence.version}.md, .json${answers ? ' and .answers.json' : ''} to ${options.out}`);
  } else {
    log(page);
  }
  return evidence.checks.some((check) => check.status === 'mismatch') ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`Release evidence could not be collected: ${error.message}`);
    process.exitCode = 1;
  });
}
