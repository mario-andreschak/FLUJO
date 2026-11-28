import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  EVIDENCE_DIRECTORY, SOURCE_METHODS, answersFile, authenticodeOf, collectReleaseEvidence, countOpenAlerts, decodeStatement, findSecrets,
  formatRecording, liveSources, main, normalizeAlert, parseChecksums, recordingSources, renderEvidencePage, replaySources,
  summarizeJestResults, summarizeStatement, withRetry,
} from './collect-release-evidence.mjs';

// The recorded answers for 3.48.10 are the fixture: they were read from GitHub,
// npm and ghcr.io on the day the committed page was collected.
const directory = fileURLToPath(new URL(`../${EVIDENCE_DIRECTORY}/`, import.meta.url));
const recording = JSON.parse(readFileSync(answersFile(directory, '3.48.10'), 'utf8'));
const COMMIT = '174ffaf034532b1ec52e483724563309e1fc9693';
const IMAGE_DIGEST = 'f7567006d333d79245ad01983905663f10dd469d5817fba4b56af0c815afe040';
const lf = (text) => text.replace(/\r\n/g, '\n');

const answersWith = (change) => {
  const answers = structuredClone(recording.answers);
  change(answers);
  return answers;
};
const keysStarting = (answers, prefix) => Object.keys(answers).filter((key) => key.startsWith(prefix));
const collect = (answers = recording.answers, options = {}) => collectReleaseEvidence({
  version: '3.48.10', sources: replaySources(answers), now: new Date(recording.collectedAt),
  hashNpmBytes: recording.options.hashNpmBytes, ...options,
});
const check = (evidence, id) => evidence.checks.find((item) => item.id === id);

test('every committed evidence page is rebuilt exactly from its saved answers, so none was edited by hand', async () => {
  const saved = readdirSync(directory).filter((file) => /^v\d+\.\d+\.\d+\.answers\.json$/.test(file));
  assert.ok(saved.length >= 1, 'at least one release has published evidence');
  for (const file of saved) {
    const answers = JSON.parse(readFileSync(`${directory}${file}`, 'utf8'));
    const evidence = await collectReleaseEvidence({
      version: answers.version, sources: replaySources(answers.answers), now: new Date(answers.collectedAt),
      hashNpmBytes: answers.options.hashNpmBytes,
    });
    const base = `${directory}v${answers.version}`;
    assert.deepEqual(evidence, JSON.parse(readFileSync(`${base}.json`, 'utf8')), `${file} no longer produces v${answers.version}.json`);
    assert.equal(renderEvidencePage(evidence), lf(readFileSync(`${base}.md`, 'utf8')),
      `v${answers.version}.md differs from what the collector writes. Re-run: npm run evidence:release -- --version ${answers.version} --out ${EVIDENCE_DIRECTORY}`);
  }
});

test('3.48.10 is tied to one commit and tree, with signed builds for npm, image and installer', async () => {
  const evidence = await collect();
  assert.equal(evidence.source.commit, COMMIT);
  assert.equal(evidence.source.tree, 'ad155c3f6f270a850786fe0233ea7cb73ad173ce');
  for (const id of ['source-commit', 'source-main', 'source-version', 'ci-verify', 'ci-publish-npm', 'ci-publish-image', 'ci-installer',
    'tests-ci', 'tests-isolated', 'npm-registry', 'npm-provenance', 'npm-bytes', 'npm-github-provenance', 'npm-sbom-signed',
    'image-digest', 'image-provenance', 'image-sbom', 'installer-asset', 'installer-provenance']) {
    assert.equal(check(evidence, id)?.status, 'ok', `${id}: ${check(evidence, id)?.detail}`);
  }
  assert.equal(check(evidence, 'npm-sbom-release').status, 'missing', 'this release predates attaching the SBOM to the release page');
  assert.match(check(evidence, 'npm-sbom-release').detail, /signed npm build record still names the SBOM/);
  assert.equal(check(evidence, 'ci-verify-full').status, 'missing');
  assert.equal(check(evidence, 'installer-code-signing').status, 'missing', 'the 3.48.10 installer carries no Authenticode signature');
  assert.match(check(evidence, 'installer-code-signing').detail, /no Authenticode signature/);
  assert.ok(evidence.tests.find((stage) => stage.stage === 'ci').tests.total >= 12_185);
  assert.equal(evidence.npm.length, 5);
  assert.deepEqual(evidence.readErrors, []);
  assert.equal(await main(['--version', '3.48.10', '--replay', answersFile(directory, '3.48.10')], { log: () => {} }), 0);
});

test('a signed build record that names another commit is a contradiction', async () => {
  const evidence = await collect(answersWith((answers) => {
    for (const statement of answers[`attestations("${IMAGE_DIGEST}")`].value) {
      if (statement.commit) statement.commit = '0'.repeat(40);
    }
  }));
  assert.equal(check(evidence, 'image-provenance').status, 'mismatch');
  assert.match(check(evidence, 'image-provenance').detail, /names commit 00000000, the release is 174ffaf0/);
  assert.match(renderEvidencePage(evidence), /Does not match/);
});

test('a build record from another workflow or a branch build is a contradiction', async () => {
  const evidence = await collect(answersWith((answers) => {
    const [key] = keysStarting(answers, 'npmAttestations("https://registry.npmjs.org/-/npm/v1/attestations/flujo-ai@');
    const statement = answers[key].value.find((item) => item.workflow);
    statement.workflow.path = '.github/workflows/other.yml';
    statement.workflow.ref = 'refs/heads/feature';
  }));
  assert.equal(check(evidence, 'npm-provenance').status, 'mismatch');
  assert.match(check(evidence, 'npm-provenance').detail, /other\.yml.*refs\/heads\/feature/);
});

test('npm provenance that signs other bytes than the registry serves is a contradiction', async () => {
  const evidence = await collect(answersWith((answers) => {
    const [key] = keysStarting(answers, 'npmAttestations("https://registry.npmjs.org/-/npm/v1/attestations/@mario.andreschak%2fmcp-bash@');
    answers[key].value.find((item) => item.workflow).subjects[0].sha512 = 'ff';
  }));
  assert.equal(check(evidence, 'npm-provenance').status, 'mismatch');
  assert.match(check(evidence, 'npm-provenance').detail, /other bytes for: @mario\.andreschak\/mcp-bash/);
});

test('downloaded npm bytes that differ from the registry hash are a contradiction', async () => {
  const evidence = await collect(answersWith((answers) => {
    answers['hashUrl("https://registry.npmjs.org/flujo-ai/-/flujo-ai-3.48.10.tgz")'].value.integrity = 'sha512-AAAA';
  }));
  assert.equal(check(evidence, 'npm-bytes').status, 'mismatch');
  assert.match(check(evidence, 'npm-bytes').detail, /flujo-ai/);
});

test('an image tag that points to other bytes is a contradiction', async () => {
  const evidence = await collect(answersWith((answers) => { answers['imageDigest("sha-174ffaf")'].value = `sha256:${'1'.repeat(64)}`; }));
  assert.equal(check(evidence, 'image-digest').status, 'mismatch');
});

test('an expired test result file is reported as missing, never as passed', async () => {
  const evidence = await collect(answersWith((answers) => {
    const artifact = answers['artifacts(44862237628)'].value.find((item) => item.name === 'jest-results-ci');
    artifact.expired = true;
  }));
  assert.equal(check(evidence, 'tests-ci').status, 'missing');
  assert.match(check(evidence, 'tests-ci').detail, /expired on \d{4}-\d{2}-\d{2}/);
  assert.match(renderEvidencePage(evidence), /not available: the result file expired/);
});

test('a failed required workflow or a failed test needs attention', async () => {
  const evidence = await collect(answersWith((answers) => {
    answers[`runs("${COMMIT}")`].value.find((run) => run.path === '.github/workflows/verify.yml').conclusion = 'failure';
    answers['jestSummary(44862237628,"jest-results-isolated")'].value.tests.failed = 2;
  }));
  assert.equal(check(evidence, 'ci-verify').status, 'attention');
  assert.equal(check(evidence, 'tests-isolated').status, 'attention');
});

test('a source that cannot be read leaves that piece unchecked and the page is still written', async () => {
  const evidence = await collect(answersWith((answers) => {
    answers['alerts("code-scanning")'] = { error: 'gh api repos/mario-andreschak/FLUJO/code-scanning/alerts?per_page=100: HTTP 403' };
    answers[`runs("${COMMIT}")`] = { error: 'gh api repos/x: HTTP 502 after 3 attempts' };
  }));
  assert.equal(check(evidence, 'alerts-code-scanning').status, 'not-checked');
  assert.match(check(evidence, 'alerts-code-scanning').detail, /HTTP 403/);
  assert.equal(check(evidence, 'ci-verify').status, 'not-checked');
  assert.equal(check(evidence, 'tests-ci').status, 'missing');
  assert.equal(evidence.readErrors.length, 2);
  const page = renderEvidencePage(evidence);
  assert.match(page, /Pieces that could not be read/);
  assert.match(page, /Code scanning \(CodeQL\) \| not readable/);
});

test('a version without a published release stops with a plain message', async () => {
  await assert.rejects(collect(answersWith((answers) => { answers['release("v3.48.10")'].value = null; })), /No published GitHub release is named v3\.48\.10/);
  await assert.rejects(collectReleaseEvidence({ version: '3.48', sources: replaySources({}) }), /Expected a version like 3\.48\.10/);
});

test('"latest" resolves through the latest release', async () => {
  const evidence = await collect(recording.answers, { version: 'latest' });
  assert.equal(evidence.version, '3.48.10');
});

test('without byte downloads the npm byte checks are shown as not checked', async () => {
  const evidence = await collect(recording.answers, { hashNpmBytes: false });
  assert.equal(check(evidence, 'npm-bytes').status, 'not-checked');
  assert.equal(check(evidence, 'npm-github-provenance'), undefined);
  assert.equal(check(evidence, 'npm-provenance').status, 'ok', 'npm provenance needs no download');
});

function withInventory(answers, change = () => {}) {
  const signed = Object.fromEntries(answers['attestations("706b10cefaec7d729c4c666bdc00f0626f1123e199823316ea71090e5fcffb0e")'].value
    .find((statement) => statement.workflow).subjects.map((subject) => [subject.name, subject.sha256]));
  const release = answers['release("v3.48.10")'].value;
  release.assets.push(
    { id: 9001, name: 'release-evidence.json', size: 900, digest: `sha256:${signed['release-evidence.json']}` },
    { id: 9002, name: 'SHA256SUMS', size: 600, digest: `sha256:${'2'.repeat(64)}` },
    { id: 9003, name: 'source-lock.sbom.cdx.json', size: 900_000, digest: `sha256:${signed['source-lock.sbom.cdx.json']}` },
  );
  const artifacts = keysStarting(answers, 'hashUrl(').map((key) => {
    const name = /registry\.npmjs\.org\/(.+)\/-\//.exec(key)[1];
    return { name, sha256: answers[key].value.sha256 };
  });
  const record = { schemaVersion: 1, revision: COMMIT, version: '3.48.10', artifacts, sbom: { sha256: signed['source-lock.sbom.cdx.json'] } };
  const sums = `${signed['release-evidence.json']}  release-evidence.json\n${signed['source-lock.sbom.cdx.json']}  source-lock.sbom.cdx.json\n`;
  change(record);
  answers['releaseAssetText(9001)'] = { value: JSON.stringify(record) };
  answers['releaseAssetText(9002)'] = { value: sums };
}

test('a release that attaches its SBOM and checksums is cross-checked against the signed record and registry bytes', async () => {
  const good = await collect(answersWith((answers) => withInventory(answers)));
  assert.equal(check(good, 'npm-sbom-release').status, 'ok', check(good, 'npm-sbom-release').detail);
  const wrong = await collect(answersWith((answers) => withInventory(answers, (record) => {
    record.revision = '1'.repeat(40);
    record.artifacts[0].sha256 = '3'.repeat(64);
  })));
  assert.equal(check(wrong, 'npm-sbom-release').status, 'mismatch');
  assert.match(check(wrong, 'npm-sbom-release').detail, /names commit 11111111/);
  assert.match(check(wrong, 'npm-sbom-release').detail, /registry bytes differ/);
});

test('alerts are counted as open at a moment from their opening and closing dates', () => {
  const alerts = [
    { state: 'open', severity: 'high', createdAt: '2026-11-01T00:00:00Z', closedAt: null },
    { state: 'fixed', severity: 'critical', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-22T00:00:00Z' },
    { state: 'fixed', severity: 'medium', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-10T00:00:00Z' },
    { state: 'open', severity: 'low', createdAt: '2026-11-23T00:00:00Z', closedAt: null },
    { state: 'dismissed', severity: 'low', createdAt: '2026-11-01T00:00:00Z', closedAt: null },
  ];
  assert.deepEqual(countOpenAlerts(alerts, '2026-11-21T00:00:00Z'), { critical: 1, high: 1, medium: 0, low: 0, total: 2, uncertain: 1 });
  assert.deepEqual(countOpenAlerts(alerts, '2026-11-25T00:00:00Z'), { critical: 0, high: 1, medium: 0, low: 1, total: 2, uncertain: 1 });
});

test('alert severity follows the security response check', () => {
  assert.deepEqual(normalizeAlert('code-scanning', { number: 1, state: 'fixed', created_at: 'a', fixed_at: 'b', rule: { severity: 'warning' } }),
    { number: 1, state: 'fixed', severity: 'medium', createdAt: 'a', closedAt: 'b' });
  assert.equal(normalizeAlert('dependabot', { number: 2, state: 'auto_dismissed', auto_dismissed_at: 'c', security_advisory: { severity: 'critical' } }).closedAt, 'c');
  assert.equal(normalizeAlert('dependabot', { number: 3, state: 'open', security_advisory: { severity: 'critical' } }).severity, 'critical');
});

test('signed statements keep only the commit, workflow, subjects and SBOM size', () => {
  const statement = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'a.tgz', digest: { sha256: 'ab' } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository: 'https://github.com/x/y', path: '.github/workflows/p.yml', ref: 'refs/heads/main' } },
        resolvedDependencies: [{ uri: 'git+https://github.com/x/y', digest: { gitCommit: COMMIT } }],
      },
      runDetails: { builder: { id: 'https://github.com/actions/runner/github-hosted' }, metadata: { invocationId: 'run/1' } },
    },
  };
  const payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  assert.deepEqual(summarizeStatement(decodeStatement(payload)), {
    predicateType: statement.predicateType, subjects: [{ name: 'a.tgz', sha256: 'ab', sha512: null }],
    workflow: { repository: 'https://github.com/x/y', path: '.github/workflows/p.yml', ref: 'refs/heads/main' },
    commit: COMMIT, run: 'run/1', builder: 'https://github.com/actions/runner/github-hosted',
  });
  const bom = summarizeStatement({ predicateType: 'https://cyclonedx.org/bom', subject: [],
    predicate: { specVersion: '1.6', metadata: { component: { name: 'img' } }, components: [{}, {}, {}] } });
  assert.deepEqual(bom.sbom, { specVersion: '1.6', root: 'img', components: 3 });
});

test('Jest results keep counts only, and checksum files are parsed line by line', () => {
  const summary = summarizeJestResults({
    numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0, numRuntimeErrorTestSuites: 0,
    numTotalTests: 5, numPassedTests: 4, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, success: true, startTime: 0,
    testResults: [{ name: '/home/runner/work/secret-path.test.ts' }],
  });
  assert.doesNotMatch(JSON.stringify(summary), /home\/runner/);
  assert.equal(summary.tests.pending, 1);
  assert.deepEqual(parseChecksums(`${'a'.repeat(64)}  flujo-setup.exe\r\n${'b'.repeat(64)} *x.json\nnot a line\n`),
    { 'flujo-setup.exe': 'a'.repeat(64), 'x.json': 'b'.repeat(64) });
});

test('short network hiccups are retried a few times; other failures are not', async () => {
  const waits = [];
  let calls = 0;
  const flaky = () => { calls += 1; if (calls < 3) throw Object.assign(new Error('x'), { stderr: 'gh: HTTP 502' }); return 'ok'; };
  assert.equal(await withRetry(flaky, { wait: (ms) => waits.push(ms) }), 'ok');
  assert.deepEqual(waits, [1000, 2000]);
  calls = 0;
  await assert.rejects(withRetry(() => { calls += 1; throw new Error('HTTP 403'); }, { wait: () => {} }), /403/);
  assert.equal(calls, 1);
  await assert.rejects(withRetry(() => { throw new Error('ECONNRESET'); }, { attempts: 2, wait: () => {} }), /ECONNRESET/);
});

test('recording keeps every answer and error; replay refuses a question that was never asked', async () => {
  const answers = {};
  const live = Object.fromEntries(SOURCE_METHODS.map((method) => [method, async (...args) => {
    if (method === 'commit') throw new Error('HTTP 403\nmore');
    return { method, args };
  }]));
  const recorded = recordingSources(live, answers);
  assert.deepEqual(await recorded.runs('abc'), { method: 'runs', args: ['abc'] });
  await assert.rejects(recorded.commit('abc'), /403/);
  const replay = replaySources(JSON.parse(formatRecording({ schemaVersion: 1, answers })).answers);
  assert.deepEqual(await replay.runs('abc'), { method: 'runs', args: ['abc'] });
  await assert.rejects(replay.commit('abc'), /^Error: HTTP 403$/);
  await assert.rejects(replay.runs('other'), /No recorded answer for runs\("other"\)/);
});

test('live sources only read: GitHub through gh GET calls, the registries through plain requests', async () => {
  const calls = [];
  const statement = Buffer.from(JSON.stringify({ predicateType: 'https://slsa.dev/provenance/v1', subject: [] })).toString('base64');
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? '';
    if (endpoint.includes('/releases/tags/')) throw Object.assign(new Error('exit 1'), { stderr: 'gh: Not Found (HTTP 404)' });
    if (endpoint.includes('/attestations/')) return JSON.stringify([statement]);
    if (endpoint.includes('/dependabot/alerts')) return `${JSON.stringify({ number: 5, state: 'open', created_at: 'a', security_advisory: { severity: 'high' }, rule: {} })}\n`;
    if (endpoint.includes('/git/ref/tags/')) return JSON.stringify({ sha: 'tagobject', type: 'tag' });
    if (endpoint.includes('/git/tags/')) return JSON.stringify({ sha: COMMIT, type: 'commit' });
    return '';
  };
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push([init.method ?? 'GET', url]);
    if (url.includes('/token?')) return new Response(JSON.stringify({ token: 'anonymous' }));
    if (url.includes('/manifests/')) return new Response(null, { status: 200, headers: { 'docker-content-digest': `sha256:${'f'.repeat(64)}` } });
    return new Response('{}', { status: 404 });
  };
  const sources = liveSources({ run, fetchImpl, wait: () => {} });
  assert.equal(await sources.release('v9.9.9'), null);
  assert.deepEqual(await sources.tagCommit('v9.9.9'), { commit: COMMIT, annotated: true });
  assert.equal((await sources.attestations('ab'))[0].predicateType, 'https://slsa.dev/provenance/v1');
  assert.deepEqual(await sources.alerts('dependabot'), [{ number: 5, state: 'open', severity: 'high', createdAt: 'a', closedAt: null }]);
  assert.equal(await sources.npmVersion('flujo-ai', '9.9.9'), null);
  assert.equal(await sources.imageDigest('9.9.9'), `sha256:${'f'.repeat(64)}`);
  for (const [command, sub, ...rest] of calls) {
    assert.equal(command, 'gh');
    assert.ok(['api', 'run'].includes(sub));
    for (const flag of ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']) assert.ok(!rest.includes(flag), `gh ${sub} ${flag}`);
  }
  assert.ok(requests.every(([method]) => ['GET', 'HEAD'].includes(method)));
});

test('committed evidence never holds a key, token, password or e-mail address', () => {
  for (const file of readdirSync(directory).filter((name) => /^v\d+\.\d+\.\d+\./.test(name))) {
    assert.deepEqual(findSecrets(readFileSync(`${directory}${file}`, 'utf8')), [], file);
  }
  assert.deepEqual(findSecrets(`token ghp_${'a'.repeat(36)} and someone@example.org`), ['GitHub token', 'e-mail address']);
  assert.deepEqual(findSecrets('flujo-ai@3.48.10.tgz by 1+flujo-app@users.noreply.github.com'), []);
});

test('the collector refuses to write evidence that would publish a secret', async () => {
  const answers = answersWith((value) => { value['commit("174ffaf034532b1ec52e483724563309e1fc9693")'].value.subject = 'Bump (owner@example.org)'; });
  const leaked = `${directory}../../../.tmp-evidence-secret.answers.json`;
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(leaked, formatRecording({ ...recording, answers }));
  try {
    await assert.rejects(main(['--version', '3.48.10', '--replay', leaked], { log: () => {} }), /Refusing to publish evidence that contains: e-mail address/);
  } finally {
    rmSync(leaked, { force: true });
  }
});

test('the Authenticode slot of a Windows program is read without Windows', () => {
  const program = (certificate) => {
    const bytes = Buffer.alloc(0x400);
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.writeUInt32LE(0x00004550, 0x80);
    bytes.writeUInt16LE(0x10b, 0x80 + 24);
    if (certificate) {
      const slot = 0x80 + 24 + 96 + 32;
      bytes.writeUInt32LE(0x300, slot);
      bytes.writeUInt32LE(0x40, slot + 4);
      bytes.writeUInt16LE(0x0002, 0x300 + 6);
    }
    return bytes;
  };
  assert.deepEqual(authenticodeOf(program(false)), { portableExecutable: true, signed: false, certificateBytes: 0 });
  assert.deepEqual(authenticodeOf(program(true)), { portableExecutable: true, signed: true, certificateBytes: 0x40 });
  assert.deepEqual(authenticodeOf(Buffer.from('not a program')), { portableExecutable: false, signed: false, certificateBytes: 0 });
});

test('a signed installer is OK; an installer that cannot be downloaded is not checked', async () => {
  const signed = await collect(answersWith((answers) => {
    answers['installerSignature("v3.48.10","flujo-setup.exe")'].value = { portableExecutable: true, signed: true, certificateBytes: 9000 };
  }));
  assert.equal(check(signed, 'installer-code-signing').status, 'ok');
  const unread = await collect(answersWith((answers) => {
    answers['installerSignature("v3.48.10","flujo-setup.exe")'] = { error: 'release download answered HTTP 502' };
  }));
  assert.equal(check(unread, 'installer-code-signing').status, 'not-checked');
  assert.match(check(unread, 'installer-code-signing').detail, /HTTP 502/);
});
