import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLedger = resolve(repositoryRoot, 'docs/audits/scorecard-563/scorecard.json');
const defaultSchema = resolve(repositoryRoot, 'docs/audits/scorecard-563/scorecard.schema.json');
const dimensions = new Map([
  ['product-fit', ['Idea / product fit', 'A-']],
  ['feature-surface', ['Feature surface', 'A-']],
  ['engineering', ['Engineering discipline', 'B+']],
  ['code-health', ['Code health', 'B-']],
  ['security', ['Security', 'C+']],
  ['maturity', ['Maturity / stability', 'C']],
  ['community', ['Community / bus factor', 'D']],
  ['docs', ['Docs honesty', 'A']],
  ['production', ['Production-readiness', 'C-']],
]);
const profiles = ['local-owner', 'persistent-worker', 'shared-public'];
const protectedBudgets = new Map([
  ['persona-append-p95', ['<', 150]], ['persona-peak-rss', ['<=', 805306368]],
  ['persona-rss-growth', ['<=', 268435456]], ['persona-append-flatness', ['<=', 2]],
  ['persona-total-collection', ['<=', 1248]], ['persona-mailbox', ['<=', 500]],
  ['persona-activities', ['<=', 200]], ['persona-dispatches', ['<=', 200]],
  ['persona-pins', ['<=', 200]], ['persona-leases', ['<=', 50]],
  ['persona-recall-p95', ['<', 150]],
]);
const supportedKeywords = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'const',
  'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'pattern', 'minimum', 'maximum', 'uniqueItems',
]);

/** Deliberately small JSON Schema vocabulary; unsupported keywords fail closed. */
export function validateShape(value, schema, root = schema, path = '$') {
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) throw new Error('Unsupported schema keyword: ' + keyword);
  }
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/')) throw new Error('Only local $defs references are supported');
    const target = root.$defs[schema.$ref.slice(8)];
    if (!target) throw new Error('Unknown schema reference: ' + schema.$ref);
    return validateShape(value, target, root, path);
  }
  const errors = [];
  const fail = message => errors.push(path + ': ' + message);
  if (schema.anyOf && !schema.anyOf.some(option => validateShape(value, option, root, path).length === 0)) fail('does not match any allowed shape');
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) fail('unexpected constant');
  if (schema.enum && !schema.enum.includes(value)) fail('unknown enum value');
  const types = {
    object: value !== null && typeof value === 'object' && !Array.isArray(value),
    array: Array.isArray(value), string: typeof value === 'string',
    number: typeof value === 'number' && Number.isFinite(value),
    integer: Number.isSafeInteger(value), boolean: typeof value === 'boolean', null: value === null,
  };
  if (schema.type && !types[schema.type]) {
    fail('expected ' + schema.type);
    return errors;
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('missing ' + key);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validateShape(child, schema.properties[key], root, path + '.' + key));
      else if (schema.additionalProperties === false) fail('unknown field ' + key);
    }
  }
  if (schema.type === 'array') {
    if (value.length < (schema.minItems ?? 0)) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('duplicate items');
    value.forEach((item, index) => errors.push(...validateShape(item, schema.items ?? {}, root, path + '[' + index + ']')));
  }
  if (schema.type === 'string') {
    if (value.trim().length < (schema.minLength ?? 0)) fail('empty/short string');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('invalid pattern');
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
  }
  return errors;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : NaN;
}
function satisfies(value, budget) {
  return ({ '<': value < budget.limit, '<=': value <= budget.limit, '>=': value >= budget.limit, '>': value > budget.limit, '=': value === budget.limit })[budget.operator];
}

/** This checks records and declared evidence correspondence, never awards a grade. */
export function validateScorecard(ledger, { root = repositoryRoot, schema = JSON.parse(readFileSync(defaultSchema, 'utf8')), verifyFiles = true } = {}) {
  const errors = validateShape(ledger, schema);
  if (errors.length) return { errors, blockers: [] };
  const fail = message => errors.push(message);
  const indexed = {};
  for (const collection of ['owners', 'profiles', 'rubric', 'budgets', 'artifacts', 'evidence', 'gates', 'claims']) {
    indexed[collection] = new Map();
    for (const entry of ledger[collection]) {
      if (indexed[collection].has(entry.id)) fail(collection + ': duplicate ID ' + entry.id);
      indexed[collection].set(entry.id, entry);
    }
  }
  function refs(ids, collection, context) {
    if (new Set(ids).size !== ids.length) fail(context + ': duplicate references');
    for (const id of ids) if (!indexed[collection].has(id)) fail(context + ': unknown ' + collection + ' ID ' + id);
  }
  function exact(actual, expected, context) {
    if (actual.length !== expected.length || expected.some(id => !actual.includes(id))) fail(context + ': required complete set is ' + expected.join(', '));
  }
  exact(ledger.rubric.map(row => row.id), [...dimensions.keys()], 'rubric');
  exact(ledger.profiles.map(profile => profile.id), profiles, 'profiles');
  for (const id of ['rubric-agreement', 'release-acceptance', 'local-security', 'worker-operations', 'shared-profile', 'human-evidence', 'persona-current-soak', 'persona-manual', 'persona-live', 'cross-stream-contracts', 'independent-reassessment']) {
    if (!indexed.gates.has(id)) fail('Required gate omitted: ' + id);
  }
  exact(ledger.issueReconciliation.map(issue => issue.issue), [520, 517, 526, 553, 547, 101, 527, 505, 435, 418, 212], 'issue reconciliation');
  for (const row of ledger.rubric) {
    const original = dimensions.get(row.id);
    if (original && (row.dimension !== original[0] || row.originalGrade !== original[1])) fail(row.id + ': original dimension/grade changed');
    refs([row.ownerId], 'owners', row.id);
  }
  for (const profile of ledger.profiles) refs(profile.gateIds, 'gates', profile.id);
  for (const budget of ledger.budgets) {
    refs([budget.ownerId], 'owners', budget.id);
    refs(budget.agreementEvidenceIds, 'evidence', budget.id);
    if (!Number.isFinite(timestamp(budget.declaredAt))) fail(budget.id + ': invalid declaredAt');
    if (budget.status === 'agreed' && budget.agreementEvidenceIds.length === 0) fail(budget.id + ': agreed budget needs retained agreement evidence');
    if (budget.status === 'agreed') {
      const records = acceptedEvidence(budget.agreementEvidenceIds, budget.id);
      if (!records.some(e => e.kind === 'external-agreement')) fail(budget.id + ': budget requires external agreement evidence');
    }
  }
  for (const [id, [operator, limit]] of protectedBudgets) {
    const actual = indexed.budgets.get(id);
    if (!actual || actual.operator !== operator || actual.limit !== limit || actual.status !== 'existing-contract') fail(id + ': existing numeric contract changed or omitted; requires a separately reviewed contract version');
  }
  for (const [role, agreement] of Object.entries(ledger.agreements)) {
    if (role === 'disagreements') continue;
    refs(agreement.evidenceIds, 'evidence', role);
    if (agreement.status === 'agreed' && (!agreement.identity || !agreement.evidenceIds.length)) fail(role + ': agreement requires identified human and retained evidence');
    if (agreement.status === 'agreed') {
      const records = acceptedEvidence(agreement.evidenceIds, role);
      if (!records.some(e => e.kind === 'external-agreement')) fail(role + ': wrong agreement evidence kind');
    }
  }
  if (ledger.agreements.maintainer.identity && ledger.agreements.maintainer.identity === ledger.agreements.independentReviewer.identity) fail('Independent reviewer cannot be the accepting maintainer');
  for (const evidence of ledger.evidence) {
    refs([evidence.ownerId], 'owners', evidence.id);
    refs(evidence.budgetIds, 'budgets', evidence.id);
    refs(evidence.profileIds, 'profiles', evidence.id);
    if (evidence.artifactId) refs([evidence.artifactId], 'artifacts', evidence.id);
    if (!Number.isFinite(timestamp(evidence.observedAt))) fail(evidence.id + ': invalid observedAt');
    const window = evidence.window;
    if (window.kind === 'simulated' && !window.simulatedDays) fail(evidence.id + ': simulated window needs simulated days');
    if (window.kind !== 'simulated' && window.simulatedDays !== null) fail(evidence.id + ': non-simulated window contains simulated days');
    if (window.kind === 'elapsed') {
      if (!Number.isFinite(timestamp(window.start)) || !Number.isFinite(timestamp(window.end)) || timestamp(window.end) <= timestamp(window.start)) fail(evidence.id + ': elapsed window requires ordered UTC start/end');
      if (timestamp(window.end) > timestamp(evidence.observedAt)) fail(evidence.id + ': evidence observed before elapsed window ended');
    }
    if (['live-provider', 'human-study'].includes(evidence.kind) && window.kind !== 'elapsed') fail(evidence.id + ': live/human evidence requires actual elapsed window');
    if (evidence.kind === 'offline-simulation' && window.kind !== 'simulated') fail(evidence.id + ': offline simulation must retain virtual-time distinction');
    const artifact = indexed.artifacts.get(evidence.artifactId);
    if (evidence.kind === 'installed-artifact' && (!artifact || artifact.kind === 'source' || artifact.sourceSha !== evidence.sourceSha)) fail(evidence.id + ': installed result needs matching release artifact/source identity');
    if (evidence.integrity === 'checksummed' && !evidence.raw.some(raw => raw.verification === 'local' && raw.sha256)) fail(evidence.id + ': checksummed evidence needs a retained local payload');
    for (const raw of evidence.raw) {
      if (raw.verification !== 'local') continue;
      if (!raw.sha256) { fail(evidence.id + ': local evidence missing SHA-256'); continue; }
      if (isAbsolute(raw.location) || raw.location.includes('\\') || /^[a-z]+:/i.test(raw.location)) { fail(evidence.id + ': local evidence location must be repository-relative'); continue; }
      const path = resolve(root, raw.location);
      const inside = target => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel); };
      if (!inside(path)) { fail(evidence.id + ': evidence path escapes repository'); continue; }
      if (verifyFiles) {
        try {
          const real = realpathSync(path);
          if (!inside(real)) throw new Error('symlink escapes repository');
          if (statSync(real).size > 5 * 1024 * 1024) throw new Error('payload exceeds 5 MiB');
          const bytes = readFileSync(real);
          const actual = createHash('sha256').update(bytes).digest('hex');
          if (actual !== raw.sha256) fail(evidence.id + ': checksum mismatch for ' + raw.location);
        } catch (error) { fail(evidence.id + ': cannot verify ' + raw.location + ': ' + error.message); }
      }
    }
    for (const metric of evidence.metrics) {
      refs([metric.budgetId], 'budgets', evidence.id + ' metric');
      const budget = indexed.budgets.get(metric.budgetId);
      if (metric.value < 0 && !metric.budgetId.endsWith('-growth')) fail(evidence.id + ': only measured growth may be negative');
      if (!evidence.budgetIds.includes(metric.budgetId)) fail(evidence.id + ': measured budget absent from budgetIds');
      if (budget && evidence.result === 'passed' && !satisfies(metric.value, budget)) fail(evidence.id + ': passing result contradicts measured ' + metric.budgetId);
      if (budget && evidence.result === 'passed' && evidence.integrity === 'checksummed') {
        if (budget.status === 'proposed') fail(evidence.id + ': proposed budget cannot establish acceptance');
        if (window.start && timestamp(budget.declaredAt) > timestamp(window.start)) fail(evidence.id + ': budget declared after measurement began');
        if (evidence.kind === 'live-provider' && budget.unit === 'seconds' && metric.value > (timestamp(window.end) - timestamp(window.start)) / 1000) fail(evidence.id + ': duration metric exceeds actual elapsed time');
      }
    }
  }
  const history = indexed.evidence.get('persona-september16-failure');
  if (!history || history.result !== 'failed' || history.kind !== 'offline-simulation' || history.sourceSha !== 'df485400e72f5772f50b1caa9674db22bfb3bf42' || !history.raw.some(raw => raw.location === 'docs/audits/scorecard-563/evidence/2026-09-16-persona-soak.json' && raw.sha256 === 'ee879bb3e0f9d7cb42b3162eacc3c625186b1941173bae8c824d1f8433af728d')) fail('Historical September 16 failed simulation must remain attributed and retained');
  function acceptedEvidence(ids, context) {
    const records = ids.map(id => indexed.evidence.get(id)).filter(Boolean);
    if (!records.length || records.some(e => e.result !== 'passed' || e.integrity !== 'checksummed')) fail(context + ': acceptance requires passing checksummed evidence, not reported metadata/failures');
    return records;
  }
  for (const artifact of ledger.artifacts) {
    refs(artifact.metadataEvidenceIds, 'evidence', artifact.id);
    if (artifact.provenance === 'verified-content') {
      if (!artifact.sourceSha || !artifact.payloadSha256) fail(artifact.id + ': verified content needs exact source and payload hash');
      const content = ledger.evidence.filter(e => e.artifactId === artifact.id && e.sourceSha === artifact.sourceSha && e.kind === (artifact.kind === 'source' ? 'source-check' : 'installed-artifact') && e.result === 'passed' && e.integrity === 'checksummed' && e.raw.some(raw => raw.verification === 'local' && raw.sha256 === artifact.payloadSha256));
      if (!content.length) fail(artifact.id + ': verified content has no matching retained content acceptance');
    }
  }
  for (const gate of ledger.gates) {
    refs([gate.ownerId], 'owners', gate.id);
    refs(gate.profileIds, 'profiles', gate.id);
    refs(gate.evidenceIds, 'evidence', gate.id);
    if (gate.status === 'passed') {
      const records = acceptedEvidence(gate.evidenceIds, gate.id);
      const expected = { source: ['source-check', 'offline-simulation'], installed: ['installed-artifact'], human: ['human-study'], live: ['live-provider'], independent: ['independent-assessment'], external: ['external-agreement'] }[gate.kind];
      if (!records.some(e => expected.includes(e.kind))) fail(gate.id + ': wrong evidence kind for gate');
      for (const profileId of gate.profileIds) {
        if (!records.some(e => expected.includes(e.kind) && e.profileIds.includes(profileId))) fail(gate.id + ': missing acceptance evidence for profile ' + profileId);
      }
    }
  }
  for (const claim of ledger.claims) {
    refs([claim.dimensionId], 'rubric', claim.id);
    refs([claim.profileId], 'profiles', claim.id);
    refs(claim.evidenceIds, 'evidence', claim.id);
    refs(claim.budgetIds, 'budgets', claim.id);
    refs(claim.gateIds, 'gates', claim.id);
    if (!['source-supported', 'release-supported'].includes(claim.status)) continue;
    const records = acceptedEvidence(claim.evidenceIds, claim.id);
    if (records.some(e => !e.profileIds.includes(claim.profileId))) fail(claim.id + ': evidence does not cover claimed profile');
    for (const kind of claim.requiredKinds) if (!records.some(e => e.kind === kind)) fail(claim.id + ': missing required evidence kind ' + kind);
    if (new Set(records.map(e => e.sourceSha)).size !== 1) fail(claim.id + ': mixed revisions cannot support one release claim');
    if (claim.budgetIds.some(id => indexed.budgets.get(id)?.status === 'proposed')) fail(claim.id + ': proposed budgets cannot qualify claim');
    for (const id of claim.budgetIds) {
      if (!records.some(e => e.metrics.some(m => m.budgetId === id && satisfies(m.value, indexed.budgets.get(id) ?? { operator: '?', limit: 0 })))) fail(claim.id + ': missing passing measurement for budget ' + id);
    }
    if (claim.status === 'source-supported' && !records.some(e => e.kind === 'source-check')) fail(claim.id + ': source-supported claim needs source checks');
    if (claim.status === 'release-supported') {
      if (!records.some(e => e.kind === 'installed-artifact')) fail(claim.id + ': source checks cannot substitute for installed-artifact acceptance');
      if (claim.gateIds.some(id => indexed.gates.get(id)?.status !== 'passed')) fail(claim.id + ': required gates remain open');
      for (const record of records.filter(e => e.kind === 'installed-artifact')) if (indexed.artifacts.get(record.artifactId)?.provenance !== 'verified-content') fail(claim.id + ': installed artifact content/provenance is unverified');
    }
  }
  for (const issue of ledger.issueReconciliation) refs(issue.evidenceIds, 'evidence', '#' + issue.issue);
  for (const id of dimensions.keys()) {
    if (!ledger.claims.some(claim => claim.dimensionId === id)) fail('Missing claim for dimension ' + id);
  }
  const assessment = ledger.assessment;
  refs(assessment.artifactIds, 'artifacts', 'assessment');
  refs(assessment.evidenceIds, 'evidence', 'assessment');
  refs(assessment.acceptedExperimentalClaimIds, 'claims', 'assessment exclusions');
  if (assessment.acceptedExperimentalClaimIds.some(id => indexed.claims.get(id)?.status !== 'experimental')) fail('Only experimental claims can be explicitly accepted as exclusions');
  if (assessment.status === 'completed') {
    if (!assessment.independent || !assessment.reviewer || !assessment.sourceSha || assessment.reviewer !== ledger.agreements.independentReviewer.identity) fail('Completed reassessment requires the agreed identified independent reviewer and exact release SHA');
    exact(assessment.grades.map(row => row.dimensionId), [...dimensions.keys()], 'assessment grades');
    const records = acceptedEvidence(assessment.evidenceIds, 'assessment');
    if (!records.some(e => e.kind === 'independent-assessment')) fail('Reassessment lacks independent assessment evidence');
    if (records.some(e => e.sourceSha !== assessment.sourceSha)) fail('Reassessment evidence does not match selected release SHA');
    if (!assessment.artifactIds.length || assessment.artifactIds.some(id => { const a = indexed.artifacts.get(id); return !a || a.provenance !== 'verified-content' || a.sourceSha !== assessment.sourceSha; })) fail('Reassessment needs verified artifacts of the same selected release SHA');
  }
  const blockers = [];
  if (ledger.agreements.maintainer.status !== 'agreed' || ledger.agreements.independentReviewer.status !== 'agreed' || ledger.agreements.disagreements.length) blockers.push('Rubric agreement/disagreements unresolved');
  if (ledger.owners.some(owner => owner.acceptance !== 'accepted' || !owner.humanName)) blockers.push('Accountable human owner assignments pending');
  if (ledger.budgets.some(b => b.status === 'proposed')) blockers.push('Proposed numeric contracts require prior agreement');
  if (ledger.profiles.some(p => p.status !== 'accepted' || p.osInstallMatrix.some(m => m.acceptance !== 'verified'))) blockers.push('Declared profiles/OS/install acceptance incomplete');
  for (const gate of ledger.gates) {
    const acceptedExperimentalLive = gate.id === 'persona-live' && assessment.status === 'completed' && assessment.acceptedExperimentalClaimIds.includes('persona-unattended');
    if (gate.status !== 'passed' && !acceptedExperimentalLive) blockers.push('Gate ' + gate.id + ': ' + gate.status);
  }
  if (ledger.claims.some(c => c.status === 'pending' || c.status === 'source-supported')) blockers.push('Release-bound claims are incomplete');
  if (ledger.claims.some(c => c.status === 'experimental' && !assessment.acceptedExperimentalClaimIds.includes(c.id))) blockers.push('Experimental exclusions not explicitly accepted by independent reviewer');
  if (assessment.status !== 'completed' || !assessment.independent || assessment.grades.length !== 9 || assessment.grades.some(g => !['A-', 'A', 'A+'].includes(g.grade))) blockers.push('All nine independent A- or better reassessments pending');
  return { errors, blockers };
}

export function runCli(args) {
  const closure = args.includes('--closure');
  const positional = args.filter(arg => arg !== '--closure');
  if (positional.length > 1 || positional.some(arg => arg.startsWith('--'))) {
    console.error('Usage: node scripts/validate-scorecard.mjs [ledger.json] [--closure]');
    return 1;
  }
  try {
    const ledger = JSON.parse(readFileSync(positional[0] ? resolve(positional[0]) : defaultLedger, 'utf8'));
    const { errors, blockers } = validateScorecard(ledger);
    if (errors.length) { console.error(errors.join('\n')); return 1; }
    console.log('Scorecard structure, references and retained checksums valid. This is not grade acceptance.');
    if (blockers.length) console.log('Closure blockers:\n- ' + blockers.join('\n- '));
    return closure && blockers.length ? 2 : 0;
  } catch (error) {
    console.error('Scorecard validation failed: ' + error.message);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = runCli(process.argv.slice(2));
