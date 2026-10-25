import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readArchivedFixture } from './read-archived-fixture.mjs';
import { readScorecardEvidence } from './read-scorecard-evidence.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const foundationPath = 'docs/quality/scorecard-foundation.json';
const historical = JSON.parse(readArchivedFixture('docs/audits/scorecard-563/scorecard.json'));
const acceptance = JSON.parse(readFileSync(resolve(repositoryRoot, 'scripts/scorecard.schema.json'), 'utf8')).$defs.acceptanceContract.const;
export const liveSpendPolicy = Object.freeze({
  denominator: 'Every provider charge attributable to a future declared run/account/model scope, including retries and failed/unknown invocations; unknown cost is not zero. No new paid provider run is authorized; a future positive cap needs an explicit contract revision and existing task authorization.',
  basis: 'Fully automated foundation task with no provider-spend authorization: zero USD is a refusal ceiling, not evidence that a paid account is funded or its accounting is enforced.',
});
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const strings = value => Array.isArray(value) && value.every(text);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel); };
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
};

/** Development contract checks. This never supplies independent judgment or grades. */
export function validateFoundation(contract, { root = repositoryRoot, now = Date.now(), sourcePackage = null } = {}) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['Contract must be an object'];
  const keys = ['contractVersion', 'issue', 'epic', 'purpose', 'declaredAt', 'historicalMinimumRevision', 'sourceBaseline', 'scope', 'developmentPolicy', 'owners', 'rubric', 'profiles', 'budgets', 'issueReconciliation', 'evidenceLedger'];
  require(Object.keys(contract).length === keys.length && keys.every(key => Object.hasOwn(contract, key)), 'Unexpected/missing contract fields');
  require(contract.contractVersion === 2 && contract.issue === 564 && contract.epic === 563, 'Wrong foundation contract identity/version');
  require(contract.historicalMinimumRevision === '03e6639812191f018e485f090761a0a6c3421fe8', 'Historical minimum revision changed');
  require(Number.isFinite(now) && Number.isFinite(timestamp(contract.declaredAt)) && timestamp(contract.declaredAt) <= now, 'Declaration requires a completed UTC wall-clock time');
  require(same(contract.scope, { objective: historical.scope.objective, profileReduction: 'none', sharedPublicAndAutonomy: 'separate-required-capabilities', externalGradeStatus: 'not-assessed' }), 'Original scope, separate capabilities or unassessed grades changed');
  const policy = contract.developmentPolicy;
  require(policy?.mode === 'fully-automated' && policy.humanResponseRequired === false && policy.humanApprovalRequired === false, 'Development must not wait for human responses/approvals');
  require(policy?.independentHumanReviewClaimed === false && policy.externalGradeAgreementClaimed === false, 'Automation cannot claim human review or external grade agreement');
  require(policy?.reviewKind === 'independent-automated-source-review' && text(policy.reviewerIdentity) && text(policy.maintainerIdentity) && policy.reviewerIdentity.startsWith(policy.maintainerIdentity + '/') && policy.mechanicalVerifier === 'scripts/check-scorecard-foundation.mjs', 'Separate automated source review and mechanical verifier must identify their actual scopes');
  require(/^https:\/\/github\.com\/mario-andreschak\/FLUJO\/issues\/564#issuecomment-\d+$/.test(policy?.reviewEvidenceUrl ?? ''), 'Automated source review needs its retained evidence reference');
  require(/^codex:[a-f0-9-]{36}$/.test(policy?.maintainerIdentity ?? '') && /^https:\/\/github\.com\/mario-andreschak\/FLUJO\/issues\/564#issuecomment-\d+$/.test(policy?.authority ?? ''), 'Development adoption needs an identified automation owner and policy reference');
  require(text(policy?.futureEvidenceRule) && strings(policy?.supersededDevelopmentConditions) && policy.supersededDevelopmentConditions.length > 0, 'Development policy must retain future evidence and explicit supersession');
  const nodeRange = (sourcePackage ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))).engines?.node;
  require(sha(contract.sourceBaseline?.sha) && text(contract.sourceBaseline?.packageVersion) && contract.sourceBaseline?.nodeRange === nodeRange, 'Source baseline and current Node prerequisites must be explicit');
  const index = (name, key, expected) => {
    const rows = contract[name];
    if (!Array.isArray(rows)) { errors.push(name + ': expected array'); return new Map(); }
    const map = new Map(rows.map(row => [row?.[key], row]));
    require(rows.length === expected.length && map.size === rows.length && expected.every(id => map.has(id)), name + ': original complete set required');
    return map;
  };
  const owners = index('owners', 'id', historical.owners.map(row => row.id));
  for (const owner of owners.values()) require(owner?.kind === 'automation' && owner.identity === policy?.maintainerIdentity && text(owner.responsibility), 'Every row needs an explicit automated accountable owner');
  const rubric = index('rubric', 'id', historical.rubric.map(row => row.id));
  for (const original of historical.rubric) {
    const row = rubric.get(original.id);
    require(row && ['dimension', 'originalGrade', 'targetGrade', 'baseline', 'ownerId'].every(key => row[key] === original[key]) && owners.has(row.ownerId), original.id + ': baseline, grade or owner changed');
    require(same(row?.criteria, original.criteria) && same(row?.evidenceRequired, original.evidenceRequired) && same(row?.issues, original.issues), original.id + ': original criteria/evidence/work must remain intact');
  }
  const profiles = index('profiles', 'id', historical.profiles.map(row => row.id));
  for (const original of historical.profiles) {
    const row = profiles.get(original.id);
    require(row?.definitionStatus === 'adopted-for-future-qualification' && row.supportedReleaseClaim === false, original.id + ': a definition is not a qualified release');
    for (const key of ['trustBoundaries', 'osInstallMatrix', 'exclusions', 'gateIds']) require(same(row?.[key], original[key]), original.id + ': original profile ' + key + ' changed');
    const prerequisites = structuredClone(original.prerequisites);
    if (original.id === 'local-owner') prerequisites[0] = 'Node ' + nodeRange + ' for this source baseline; the chosen distribution must declare its own exact runtime identity. Provider credential/subscription/quota or compatible local model; network as selected.';
    require(same(row?.prerequisites, prerequisites), original.id + ': current platform/provider/tool prerequisites changed');
  }
  const budgets = index('budgets', 'id', historical.budgets.map(row => row.id));
  for (const original of historical.budgets) {
    const row = budgets.get(original.id);
    const protectedFields = ['ownerId', 'metric', 'operator', 'unit', 'window', 'observation'];
    if (original.id !== 'live-spend') protectedFields.push('limit', 'denominator', 'basis');
    require(row && protectedFields.every(key => same(row[key], original[key])), original.id + ': numeric target/denominator/window weakened or changed');
    require(row?.status === 'adopted-for-future-measurement' && row.measurementStatus === 'not-measured-by-this-contract' && row.declaredAt === contract.declaredAt, original.id + ': future measurement must follow declaration');
    require(row?.originalStatus === original.status && row.originalDeclaredAt === original.declaredAt && same(row.agreementEvidenceIds, original.agreementEvidenceIds), original.id + ': historical status/evidence must remain distinct');
    if (original.id === 'live-spend') require(row?.limit === 0 && row.denominator === liveSpendPolicy.denominator && row.basis === liveSpendPolicy.basis, 'Live spending requires the complete zero-dollar refusal ceiling/accounting policy; no funded account is claimed');
  }
  const reconciliations = index('issueReconciliation', 'number', historical.issueReconciliation.map(row => row.issue));
  for (const row of reconciliations.values()) {
    require(['OPEN', 'CLOSED'].includes(row?.state) && text(row.sourceStatus) && row.selectedReleaseStatus === 'not-qualified-by-this-contract', 'Issue state must not qualify a release');
    require(text(row?.scopeLimits) && /^https:\/\/github\.com\/mario-andreschak\/FLUJO\/(issues|pull)\/\d+/.test(row?.evidenceUrl ?? ''), 'Reconciliation needs source evidence and scope limits');
  }
  const fields = ['id', 'kind', 'sourceSha', 'artifactIdentity', 'profileId', 'command', 'platform', 'ownerId', 'startedAt', 'finishedAt', 'clock', 'result', 'rawLocation', 'rawSha256', 'scopeLimits', 'budgetIds', 'numerator', 'denominator'];
  require(contract.evidenceLedger?.format === 'source-release-evidence-collection/v2' && same(contract.evidenceLedger.requiredFields, fields), 'Evidence ledger must retain the complete measurement identity');
  require(same(contract.evidenceLedger?.allowedResults, ['unverified', 'passed', 'failed', 'skipped', 'manual', 'unknown']), 'Failures/skips/manual/unknown evidence must remain recordable');
  require(same(contract.evidenceLedger?.kinds, ['source-check', 'offline-simulation', 'installed-artifact', 'human-study', 'live-provider', 'security-review', 'independent-assessment']), 'Evidence kinds must remain separate');
  require(same(contract.evidenceLedger?.distinctions, ['unintegrated-local-work', 'integrated-source', 'reported-specific-release', 'verified-installed-artifact', 'unverified-claim']), 'Source/local/released/unverified distinctions required');
  require(contract.evidenceLedger?.closureValidator === 'scripts/validate-scorecard.mjs' && text(contract.evidenceLedger.closureRule), 'Original final-grade validator remains separate');
  return errors;
}

/** Start a new external collection, with exact clean source and no invented passes. */
export function initializeLedger(directory, { root = repositoryRoot } = {}) {
  if (existsSync(directory)) throw new Error('Output directory already exists; never overwrite evidence');
  const parent = realpathSync(dirname(resolve(directory)));
  const output = resolve(parent, basename(directory));
  if (inside(realpathSync(root), output)) throw new Error('Evidence must stay outside the source checkout');
  if (git(root, ['status', '--porcelain'])) throw new Error('Collection requires a clean committed source');
  const sourceSha = git(root, ['rev-parse', 'HEAD']);
  const sourceTree = git(root, ['rev-parse', sourceSha + '^{tree}']);
  const bytes = Buffer.from(execFileSync('git', ['show', sourceSha + ':' + foundationPath], { cwd: root, windowsHide: true }));
  const contract = JSON.parse(bytes);
  const sourcePackage = JSON.parse(execFileSync('git', ['show', sourceSha + ':package.json'], { cwd: root, windowsHide: true }));
  const errors = validateFoundation(contract, { root, sourcePackage });
  if (errors.length) throw new Error(errors.join('\n'));
  const collection = { format: contract.evidenceLedger.format, createdAt: new Date().toISOString(), contractFile: 'contract.json', contractSha256: hash(bytes),
    source: { sha: sourceSha, tree: sourceTree, dirty: false, packageVersion: sourcePackage.version, platform: process.platform + '-' + process.arch, node: process.version },
    distributions: ['npm', 'container', 'windows-installer'].map(kind => ({ kind, identity: null, sourceSha: null, status: 'unselected' })),
    records: [], assessment: { status: 'not-assessed', grades: [] },
    scope: 'Evidence collection only. No selected distribution, executed measurement, independent review, release qualification or grade is implied.' };
  if (git(root, ['rev-parse', 'HEAD']) !== sourceSha || git(root, ['status', '--porcelain'])) throw new Error('Source changed during collection capture');
  mkdirSync(output);
  writeFileSync(resolve(output, 'contract.json'), bytes, { flag: 'wx' });
  writeFileSync(resolve(output, 'ledger.json'), JSON.stringify(collection, null, 2) + '\n', { flag: 'wx' });
  return collection;
}

/** Validate collection correspondence, not whether a measured claim is accepted. */
export function validateCollection(ledger, { root = repositoryRoot, evidenceRoot, now = Date.now() } = {}) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!ledger || typeof ledger !== 'object' || !evidenceRoot) return ['Collection and evidence root required'];
  const keys = ['format', 'createdAt', 'contractFile', 'contractSha256', 'source', 'distributions', 'records', 'assessment', 'scope'];
  require(Object.keys(ledger).length === keys.length && keys.every(key => Object.hasOwn(ledger, key)), 'Unexpected/missing collection fields');
  require(ledger.format === 'source-release-evidence-collection/v2' && Number.isFinite(timestamp(ledger.createdAt)) && timestamp(ledger.createdAt) <= now, 'Invalid collection identity/time');
  require(sha(ledger.source?.sha) && sha(ledger.source?.tree) && ledger.source?.dirty === false && text(ledger.source?.packageVersion) && text(ledger.source?.platform) && text(ledger.source?.node), 'Exact clean source/platform/runtime identity required');
  require(same(ledger.assessment, { status: 'not-assessed', grades: [] }), 'A collection cannot award grades or independent acceptance');
  let contract;
  try {
    if (!sha(ledger.source?.sha)) throw new Error('Recorded source must be a full commit SHA');
    if (ledger.contractFile !== 'contract.json') throw new Error('Frozen contract filename must be contract.json');
    const bytes = readScorecardEvidence(resolve(evidenceRoot, ledger.contractFile), evidenceRoot);
    require(hash(bytes) === ledger.contractSha256, 'Frozen contract checksum mismatch');
    require(hash(execFileSync('git', ['show', ledger.source.sha + ':' + foundationPath], { cwd: root, windowsHide: true })) === ledger.contractSha256, 'Frozen contract differs from recorded source');
    require(git(root, ['rev-parse', ledger.source.sha + '^{tree}']) === ledger.source.tree, 'Recorded source tree mismatch');
    contract = JSON.parse(bytes);
    const sourcePackage = JSON.parse(execFileSync('git', ['show', ledger.source.sha + ':package.json'], { cwd: root, windowsHide: true }));
    require(ledger.source.packageVersion === sourcePackage.version, 'Recorded package version differs from immutable source');
    errors.push(...validateFoundation(contract, { root, now, sourcePackage }));
  } catch (error) { errors.push('Frozen contract/source: ' + error.message); }
  if (!contract || errors.length) return errors;
  const distributions = ledger.distributions;
  require(Array.isArray(distributions) && distributions.length === 3 && new Set(distributions.map(d => d.kind)).size === 3 && ['npm', 'container', 'windows-installer'].every(kind => distributions.some(d => d.kind === kind)), 'Each distribution identity must stay separate');
  for (const distribution of Array.isArray(distributions) ? distributions : []) require(
    distribution.status === 'unselected' ? distribution.identity === null && distribution.sourceSha === null
      : distribution.status === 'observed-metadata' && text(distribution.identity) && sha(distribution.sourceSha), 'A collection may retain metadata, not declare verified installed content');
  if (!Array.isArray(ledger.records)) return [...errors, 'Records must be an array'];
  require(new Set(ledger.records.map(row => row?.id)).size === ledger.records.length, 'Duplicate evidence IDs');
  for (const row of ledger.records) {
    if (!row || !contract) { errors.push('Invalid evidence record/contract'); continue; }
    require(contract.evidenceLedger.requiredFields.every(key => Object.hasOwn(row, key)), 'Evidence measurement identity incomplete');
    require(text(row.id) && row.sourceSha === ledger.source?.sha && strings(row.command) && row.command.length > 0 && text(row.platform), 'Evidence must bind command/platform to the recorded source');
    require(row.artifactIdentity === 'source:' + row.sourceSha || (Array.isArray(distributions) && distributions.some(d => d.identity !== null && d.identity === row.artifactIdentity && d.sourceSha === row.sourceSha)), 'Evidence artifact identity is unselected or mismatched');
    require(row.profileId === null || contract.profiles.some(p => p.id === row.profileId), 'Unknown evidence profile');
    require(contract.owners.some(owner => owner.id === row.ownerId) && strings(row.scopeLimits) && row.scopeLimits.length > 0, 'Evidence needs accountable ownership and scope limits');
    require(contract.evidenceLedger.allowedResults.includes(row.result) && contract.evidenceLedger.kinds.includes(row.kind), 'Evidence result/kind must preserve its actual scope');
    require(['instant', 'elapsed', 'simulated'].includes(row.clock) && Number.isFinite(timestamp(row.startedAt)) && timestamp(row.startedAt) >= timestamp(contract.declaredAt) && timestamp(row.finishedAt) >= timestamp(row.startedAt) && timestamp(row.finishedAt) <= now, 'Evidence must follow preregistration and have a completed actual window');
    require(Array.isArray(row.budgetIds) && new Set(row.budgetIds).size === row.budgetIds.length && row.budgetIds.every(id => contract.budgets.some(b => b.id === id)), 'Unknown/duplicated budget binding');
    if (row.result === 'passed') {
      if (row.kind === 'installed-artifact') require(row.profileId !== null && distributions.some(d => d.identity !== null && d.identity === row.artifactIdentity && d.sourceSha === row.sourceSha), 'Passed installed observations need a selected distribution and explicit profile');
      if (['human-study', 'live-provider'].includes(row.kind)) require(row.clock === 'elapsed', 'Passed human/live observations require an elapsed clock');
      if (Array.isArray(row.budgetIds)) {
        require(row.budgetIds.every(id => acceptance.metricEvidenceKinds[id]?.includes(row.kind)), 'Passing budget observation has the wrong evidence kind');
        for (const id of row.budgetIds) {
          const observation = contract.budgets.find(b => b.id === id)?.observation;
          if (!observation) continue;
          require((observation.clock === 'any' || row.clock === observation.clock)
            && (timestamp(row.finishedAt) - timestamp(row.startedAt)) / 1000 >= observation.minimumSeconds
            && Number.isSafeInteger(row.denominator) && row.denominator >= observation.minimumDenominator
            && (observation.minimumSimulatedDays === 0 || (Number.isFinite(row.simulatedDays) && row.simulatedDays >= observation.minimumSimulatedDays)), 'Passing observation is below its preregistered clock/window/denominator floor');
          if (row.kind === 'source-check' && acceptance.sourceMetricElapsedBudgets.includes(id)) require(row.clock === 'elapsed', 'This source metric requires an elapsed clock');
        }
      }
    }
    require((row.numerator === null && row.denominator === null) || (Number.isSafeInteger(row.denominator) && row.denominator > 0 && (row.numerator === null || (Number.isSafeInteger(row.numerator) && row.numerator >= 0 && row.numerator <= row.denominator))), 'Evidence needs actual numerator/denominator or explicit nulls');
    try {
      if (!text(row.rawLocation) || !/^[a-f0-9]{64}$/.test(row.rawSha256 ?? '')) throw new Error('Raw location/checksum missing');
      require(hash(readScorecardEvidence(resolve(evidenceRoot, row.rawLocation), evidenceRoot)) === row.rawSha256, 'Raw evidence checksum mismatch');
    } catch (error) { errors.push('Raw evidence: ' + error.message); }
  }
  return errors;
}

export function runCli(args) {
  try {
    if (args.length === 2 && args[0] === '--init') {
      const collection = initializeLedger(resolve(args[1]));
      console.log(JSON.stringify({ result: 'unmeasured-external-collection-created', source: collection.source, ledger: resolve(args[1], 'ledger.json'), scope: collection.scope }));
      return 0;
    }
    let errors;
    if (args.length === 2 && args[0] === '--collection') {
      const path = resolve(args[1]);
      const ledger = JSON.parse(readScorecardEvidence(path, dirname(path)));
      errors = validateCollection(ledger, { evidenceRoot: dirname(path) });
    } else if (args.length === 0) errors = validateFoundation(JSON.parse(readFileSync(resolve(repositoryRoot, foundationPath), 'utf8')));
    else throw new Error('Usage: node scripts/check-scorecard-foundation.mjs [--init <new-external-directory> | --collection <ledger.json>]');
    if (errors.length) { console.error(errors.join('\n')); return 1; }
    console.log('Foundation/collection consistency valid. No independent judgment, installed-release acceptance or scorecard grade is awarded.');
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = runCli(process.argv.slice(2));
