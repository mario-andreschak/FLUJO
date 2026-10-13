import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBaselineOptions, runInstalledBaseline } from './maintainer-installed-baseline.mjs';
import { recoverIntoFreshRoot, upgradeExistingRoot } from './maintainer-installed-recovery.mjs';
import { validateReleaseEvidence, verifyReleaseAttestations } from './release-evidence.mjs';
import { requireSuccessfulVerification } from './require-release-verification.mjs';
import { assertVerificationAttempt, assertVerificationJobs } from './verification-contract.mjs';

const repository = 'mario-andreschak/FLUJO';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'Usage: node scripts/maintainer-installed-upgrade.mjs '
  + '--baseline-version=VERSION --baseline-integrity=SHA512_SRI --baseline-source-revision=SHA '
  + '--candidate-version=VERSION --candidate-integrity=SHA512_SRI --candidate-source-revision=SHA '
  + '--candidate-evidence=ABSOLUTE_RELEASE_DIRECTORY [--npm-cli=ABSOLUTE_NPM_CLI_JS]';

export function parseUpgradeOptions(args) {
  const values = {};
  for (const arg of args) {
    const match = /^--(baseline-version|baseline-integrity|baseline-source-revision|candidate-version|candidate-integrity|candidate-source-revision|candidate-evidence|npm-cli)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(values, match[1])) throw new Error(usage);
    values[match[1]] = match[2];
  }
  const pin = prefix => parseBaselineOptions(['version', 'integrity', 'source-revision'].map(name => `--${name}=${values[`${prefix}-${name}`] ?? ''}`)
    .concat(values['npm-cli'] ? [`--npm-cli=${values['npm-cli']}`] : []));
  const baseline = pin('baseline'); const candidate = pin('candidate');
  const parts = version => version.split('.').map(part => {
    if (!/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part))) throw new Error(usage);
    return Number(part);
  });
  const before = parts(baseline.version); const after = parts(candidate.version);
  const difference = after.findIndex((value, index) => value !== before[index]);
  if (difference < 0 || after[difference] < before[difference] || !path.isAbsolute(values['candidate-evidence'] ?? '')) {
    throw new Error('A greater candidate version and absolute candidate evidence directory are required.');
  }
  return { baseline, candidate, candidateEvidence: values['candidate-evidence'] };
}

export function assertCandidateScans(analyses, alerts, revision) {
  if (!Array.isArray(analyses) || !Array.isArray(alerts) || alerts.length) throw new Error('Candidate has missing scan evidence or open main CodeQL findings.');
  const selected = [];
  for (const language of ['javascript-typescript', 'actions']) {
    const matches = analyses.filter(item => item.commit_sha === revision && item.ref === 'refs/heads/main'
      && item.category === `/language:${language}`).sort((a, b) => b.id - a.id);
    const analysis = matches[0];
    if (!analysis || analysis.tool?.name !== 'CodeQL' || analysis.error !== '' || analysis.warning !== '' || !Number.isSafeInteger(analysis.rules_count) || analysis.rules_count < 1
        || !Number.isSafeInteger(analysis.id) || analysis.id < 1 || !Number.isSafeInteger(analysis.results_count) || analysis.results_count < 0) {
      throw new Error(`Candidate ${language} analysis is missing, incomplete or warned.`);
    }
    selected.push({ id: analysis.id, language, sourceRevision: revision, results: analysis.results_count,
      evaluatedRules: analysis.rules_count, ref: analysis.ref });
  }
  return selected;
}

export function assertCandidateScanReport(sarif, analysis) {
  const category = `/language:${analysis.language}`;
  if (sarif?.version !== '2.1.0' || !Array.isArray(sarif.runs) || sarif.runs.length !== 1) {
    throw new Error('Candidate CodeQL SARIF is missing or has an unexpected run scope.');
  }
  const report = sarif.runs[0]; const extensions = report.tool?.extensions ?? [];
  if (report.tool?.driver?.name !== 'CodeQL' || !Array.isArray(extensions)
      || ![category, `${category}/`].includes(report.automationDetails?.id)
      || extensions.some(extension => extension.name === 'codeql-action/pr-diff-range')
      || report.properties?.incrementalMode === 'diff-informed') {
    throw new Error('Candidate CodeQL SARIF is partial, diff-informed or belongs to another category.');
  }
  const provenance = report.versionControlProvenance;
  if (!Array.isArray(provenance) || provenance.length !== 1
      || provenance[0].repositoryUri !== `https://github.com/${repository}`
      || provenance[0].revisionId !== analysis.sourceRevision || provenance[0].branch !== 'refs/heads/main') {
    throw new Error('Candidate CodeQL SARIF does not establish the selected official main source.');
  }
  const queries = report.properties?.codeqlConfigSummary?.queries;
  if (!Array.isArray(queries) || queries.length !== 1 || queries[0].type !== 'builtinSuite' || queries[0].uses !== 'security-extended') {
    throw new Error('Candidate CodeQL SARIF does not establish the configured security-extended suite.');
  }
  if ([report.tool.driver, ...extensions].some(tool => !Array.isArray(tool.rules ?? []))) {
    throw new Error('Candidate CodeQL SARIF has an invalid rule collection.');
  }
  const rules = [report.tool.driver, ...extensions].flatMap(tool => tool.rules ?? []);
  if (rules.length !== analysis.evaluatedRules || rules.some(rule => typeof rule.id !== 'string' || !rule.id)
      || new Set(rules.map(rule => rule.id)).size !== rules.length
      || !Array.isArray(report.results) || report.results.length !== analysis.results
      || (analysis.language === 'javascript-typescript' && !rules.some(rule => rule.id === 'js/http-to-file-access'))) {
    throw new Error('Candidate CodeQL SARIF rules or results differ from the selected analysis.');
  }
  return { category, evaluatedRules: rules.length,
    results: report.results.length, diffInformed: false, suite: 'security-extended' };
}

function normalizeOptions(options) {
  if (options.baseline?.npmCli !== options.candidate?.npmCli) throw new Error('Use the same explicitly selected npm CLI for both consumers.');
  const args = ['baseline', 'candidate'].flatMap(role => [
    `--${role}-version=${options[role]?.version ?? ''}`,
    `--${role}-integrity=${options[role]?.integrity ?? ''}`,
    `--${role}-source-revision=${options[role]?.artifactSourceRevision ?? ''}`,
  ]).concat(`--candidate-evidence=${options.candidateEvidence ?? ''}`);
  if (options.baseline?.npmCli) args.push(`--npm-cli=${options.baseline.npmCli}`);
  return parseUpgradeOptions(args);
}

/** Actual CLI callers use the canonical official-main and signer gates; tests can supply a command fixture. */
export async function qualifyCandidate(options, run) {
  options = normalizeOptions(options);
  const { candidate, candidateEvidence } = options;
  const evidence = validateReleaseEvidence({ directory: candidateEvidence, sha: candidate.artifactSourceRevision, version: candidate.version });
  const artifact = evidence.artifacts.find(item => item.name === 'flujo-ai');
  if (!artifact || artifact.integrity !== candidate.integrity) throw new Error('Candidate package pin differs from its distribution evidence.');
  const api = endpoint => JSON.parse(run('gh', ['api', `repos/${repository}/${endpoint}`]));
  const workflow = api('actions/workflows/verify.yml');
  if (workflow.path !== '.github/workflows/verify.yml' || !Number.isSafeInteger(workflow.id) || workflow.state !== 'active') {
    throw new Error('Official candidate verification workflow is unavailable.');
  }
  let acceptedAttempt;
  const revision = candidate.artifactSourceRevision;
  const verificationOptions = { revision, workflowId: workflow.id, attempts: 1,
    listRuns: () => JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', String(workflow.id),
      '--commit', revision, '--branch', 'main', '--event', 'push', '--limit', '10',
      '--json', 'databaseId,workflowDatabaseId,headSha,headBranch,event,status,conclusion'])),
    watchRun: () => { throw new Error('Candidate main verification is still live; no consumer install allowed.'); },
    readRunEvidence: id => {
      const attempt = api(`actions/runs/${id}`);
      assertVerificationAttempt(attempt, { revision, workflowId: workflow.id, runId: id });
      const pages = JSON.parse(run('gh', ['api', `repos/${repository}/actions/runs/${id}/attempts/${attempt.run_attempt}/jobs?per_page=100`, '--paginate', '--slurp']));
      if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page.jobs))) throw new Error('Invalid candidate job pages.');
      const current = api(`actions/runs/${id}`);
      assertVerificationAttempt(current, { revision, workflowId: workflow.id, runId: id });
      if (current.run_attempt !== attempt.run_attempt) throw new Error('Candidate verification was rerun during admission.');
      const jobs = pages.flatMap(page => page.jobs); assertVerificationJobs(jobs);
      acceptedAttempt = { id, attempt: attempt.run_attempt, jobs: jobs.map(({ name, status, conclusion }) => ({ name, status, conclusion })) };
      return { run: attempt, jobs };
    },
  };
  const verificationRunId = await requireSuccessfulVerification(verificationOptions);
  const acceptedAttemptNumber = acceptedAttempt.attempt;
  const readScanMetadata = () => {
    const analysisPages = JSON.parse(run('gh', ['api', `repos/${repository}/code-scanning/analyses?ref=refs%2Fheads%2Fmain&per_page=100`, '--paginate', '--slurp']));
    const alertPages = JSON.parse(run('gh', ['api', `repos/${repository}/code-scanning/alerts?ref=refs%2Fheads%2Fmain&state=open&per_page=100`, '--paginate', '--slurp']));
    if (![analysisPages, alertPages].every(pages => Array.isArray(pages) && pages.every(Array.isArray))) throw new Error('Invalid paginated candidate scan evidence.');
    return assertCandidateScans(analysisPages.flat(), alertPages.flat(), revision);
  };
  const readCompleteScans = () => {
    const selected = readScanMetadata();
    const complete = selected.map(analysis => {
      const bytes = run('gh', ['api', '-H', 'Accept: application/sarif+json', `repos/${repository}/code-scanning/analyses/${analysis.id}`]);
      return { ...analysis, report: { ...assertCandidateScanReport(JSON.parse(bytes), analysis),
        rawSha256: digest(bytes), rawBytes: Buffer.byteLength(bytes) } };
    });
    const current = readScanMetadata();
    if (JSON.stringify(current) !== JSON.stringify(selected)) throw new Error('Candidate scan analyses changed while inspecting SARIF.');
    return complete;
  };
  const scansBeforeSignatures = readCompleteScans();
  verifyReleaseAttestations({ run, directory: candidateEvidence, sha: revision, version: candidate.version });
  const finalRun = await requireSuccessfulVerification(verificationOptions);
  if (finalRun !== verificationRunId || acceptedAttempt.attempt !== acceptedAttemptNumber) throw new Error('Candidate verification changed while verifying signatures.');
  const scans = readCompleteScans();
  return { result: 'passed-automated-candidate-admission', version: candidate.version, sourceRevision: revision,
    integrity: candidate.integrity, verificationRunId, acceptedAttempt, scansBeforeSignatures, scans, openMainCodeqlFindings: 0,
    signerWorkflow: `${repository}/.github/workflows/publish-npm.yml`, signerSourceRef: 'refs/heads/main',
    selfHostedSignersAccepted: false, independentHumanAcceptance: false };
}

export async function runVersionTransition(options) {
  options = normalizeOptions(options);
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Version transition requires clean committed tool source.');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-maintainer-upgrade-'));
  const receipt = { schemaVersion: 1, kind: 'automated-installed-version-transition', result: 'failed',
    toolRevision: revision, toolScriptSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    directory, platform: process.platform, arch: process.arch, node: process.version,
    startedAt: new Date().toISOString(), sourceCleanBefore: true, sourceCleanAfter: null,
    baseline: options.baseline, candidate: options.candidate, commands: [], operations: [],
    pending: ['baseline-provenance-signature-verification', 'candidate-npm-provenance-signature-verification', 'independent-human-review', 'human-operated-drill',
      'private-triage-tabletop', 'broader-state-and-schedule-recovery', 'verified-backup-access', '90-day-observation', 'independent-reassessment'],
    limits: ['Observed public seed inventory plus synthetic flow/conversation/theme/non-secret variable; no provider/model, identities/secrets, Persona or schedule continuity.',
      'Automated main/signature/scan gates do not establish human role consent, independence or an A- judgment.',
      'Owned launcher/port receipts do not certify every descendant generation or hostile-code isolation.'] };
  const run = (command, args) => {
    const index = receipt.commands.length + 1;
    const stdout = `qualification-${index}.stdout.txt`; const stderr = `qualification-${index}.stderr.txt`;
    const record = { command, args, stdout, stderr }; receipt.commands.push(record);
    try {
      const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
      writeFileSync(path.join(directory, stdout), output, { flag: 'wx' }); writeFileSync(path.join(directory, stderr), '', { flag: 'wx' });
      record.code = 0; return output;
    } catch (error) {
      record.code = error.status; record.signal = error.signal;
      writeFileSync(path.join(directory, stdout), error.stdout ?? '', { flag: 'wx' });
      writeFileSync(path.join(directory, stderr), error.stderr ?? error.message, { flag: 'wx' }); throw error;
    }
  };
  try {
    receipt.candidateAdmission = await qualifyCandidate(options, run);
    // No registry read, npm install or application launch occurs before admission.
    const recordOperation = (role, operation) => receipt.operations.push({ role, directory: operation.directory,
      result: operation.receipt.result, receiptSha256: digest(readFileSync(path.join(operation.directory, 'receipt.json'))) });
    const baseline = await runInstalledBaseline(options.baseline);
    recordOperation('baseline', baseline);
    if (baseline.receipt.result !== 'passed-baseline-probe') throw new Error('Baseline consumer probe failed.');
    if (baseline.receipt.provenanceSignatureVerified !== true) throw new Error('Baseline npm provenance was not verified.');
    if (baseline.receipt.syntheticState?.verified !== true) throw new Error('Baseline broader synthetic state was not verified.');
    if (baseline.receipt.flowInventory?.schemaVersion !== 1 || baseline.receipt.flowInventory.verified !== true) throw new Error('Baseline complete flow inventory was not verified.');
    receipt.pending = receipt.pending.filter(item => item !== 'baseline-provenance-signature-verification');
    const candidate = await runInstalledBaseline(options.candidate);
    recordOperation('candidate-consumer', candidate);
    if (candidate.receipt.result !== 'passed-baseline-probe') throw new Error('Candidate consumer probe failed.');
    if (candidate.receipt.provenanceSignatureVerified !== true) throw new Error('Candidate npm provenance was not verified.');
    if (candidate.receipt.syntheticState?.verified !== true) throw new Error('Candidate broader synthetic state was not verified.');
    if (candidate.receipt.flowInventory?.schemaVersion !== 1 || candidate.receipt.flowInventory.verified !== true) throw new Error('Candidate complete flow inventory was not verified.');
    receipt.pending = receipt.pending.filter(item => item !== 'candidate-npm-provenance-signature-verification');
    const upgrade = await upgradeExistingRoot(baseline, candidate);
    recordOperation('existing-data-upgrade', upgrade);
    if (upgrade.receipt.result !== 'passed-version-upgrade' || !upgrade.receipt.baselineDataFoundBeforeRestore
        || !upgrade.receipt.baselineStateFoundBeforeRestore || upgrade.receipt.syntheticState?.verified !== true
        || !upgrade.receipt.baselineFlowsFoundBeforeRestore || upgrade.receipt.flowInventory?.verified !== true) throw new Error('Existing-data candidate upgrade failed.');
    const recovery = await recoverIntoFreshRoot(baseline, candidate);
    recordOperation('baseline-backup-to-fresh-candidate', recovery);
    if (recovery.receipt.result !== 'passed-fresh-recovery' || !recovery.receipt.preRestoreStateAbsent
        || recovery.receipt.syntheticState?.verified !== true || !recovery.receipt.preRestoreFlowInventoryVerified
        || recovery.receipt.flowInventory?.verified !== true) throw new Error('Fresh candidate recovery failed.');
    receipt.candidateAdmissionAfter = await qualifyCandidate(options, run);
    receipt.result = 'passed-version-transition-probe';
  } catch (error) { receipt.failure = error.message; }
  finally {
    try {
      receipt.sourceCleanAfter = git(['rev-parse', 'HEAD']) === revision && !git(['status', '--porcelain', '--untracked-files=normal']);
      if (!receipt.sourceCleanAfter) throw new Error('Version-transition source changed during execution.');
    } catch (error) { receipt.sourceCleanAfter = false; receipt.result = 'failed'; receipt.sourceFailure = error.message; }
    receipt.completedAt = new Date().toISOString();
    receipt.evidence = receipt.commands.flatMap(command => [command.stdout, command.stderr]).map(name => {
      const bytes = readFileSync(path.join(directory, name)); return { path: name, bytes: bytes.length, sha256: digest(bytes) };
    });
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    writeFileSync(path.join(directory, 'receipt.json'), bytes, { flag: 'wx' });
    writeFileSync(path.join(directory, 'receipt.sha256'), `${digest(bytes)}  receipt.json\n`, { flag: 'wx' });
  }
  return { directory, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
    else {
      const result = await runVersionTransition(parseUpgradeOptions(process.argv.slice(2)));
      console.log(JSON.stringify({ result: result.receipt.result, directory: result.directory, failure: result.receipt.failure }));
      if (result.receipt.result !== 'passed-version-transition-probe') process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
