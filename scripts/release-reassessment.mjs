// Automated release reassessment (#578). Goes through every acceptance point of
// issue #578 and the A− criteria of the nine scorecard rows (#563) for one
// release, and records a verdict with its evidence for each.
//
// It reads three kinds of input and keeps them in the result, so the page can
// be judged again offline and nobody can edit it by hand:
//   - the release evidence JSON from scripts/collect-release-evidence.mjs;
//   - files at the assessed commit (docs, workflows, contract, pilot sheets);
//   - a few public GitHub facts (issues, contributors, merge rules, alerts);
//   - optionally the offline Persona soak artifacts for that commit.
//
//   node scripts/release-reassessment.mjs --evidence docs/quality/release-evidence/v3.48.10.json --source v3.48.10 \
//     [--soak <soak-artifacts dir>] [--out docs/quality/release-evidence]
//   node scripts/release-reassessment.mjs --replay docs/quality/release-evidence/v3.48.10.reassessment.json
//
// `--source <git ref>` reads the files of that commit with `git show`; without
// it the working tree is read (CI checks out the release commit). Exit code 1
// means the inputs could not be read; a criterion that is not met is a verdict,
// not an error.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkDocsClaims, CLAIM_FILES } from './check-docs-claims.mjs';
import { findSecrets, withRetry } from './collect-release-evidence.mjs';
import { REPOSITORY } from './npm-release.mjs';
import { FIRST_RUN_COLUMNS, WEEKLY_COLUMNS, checkFirstRun, checkWeekly, readSheet } from './product-fit-pilot/sheets.mjs';
import { evaluateSecurityResponse } from './security-response-check.mjs';
import { validatePersonaSoakArtifacts } from './validate-persona-soak-artifacts.mjs';

export const SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;
const SHA = /^[a-f0-9]{40}$/;

/** Accounts that are the project itself: the owner, its agent account and bots never count as outside people. */
export const PROJECT_ACCOUNTS = Object.freeze(['mario-andreschak', 'flujo-app']);
const PROJECT_GIT_NAMES = Object.freeze(['flujo-app', 'flujo', 'flujo agent', 'mario-andreschak', 'mario', 'mario andreschak']);
const isBot = (login, type) => type === 'Bot' || /\[bot\]$/i.test(login ?? '');
const isOutsideHuman = ({ login, type }) => Boolean(login) && !isBot(login, type) && !PROJECT_ACCOUNTS.includes(login.toLowerCase());

/** Labels that mark an open issue as a critical problem. */
export const CRITICAL_LABELS = Object.freeze(['!!!!---CRITICAL---!!!!', 'priority: critical', 'urgent', 'vulnerability']);

/** The files the external audit named as hot spots, with their size when #571 was planned (2026-10-03). */
export const HOT_SPOTS = Object.freeze([
  { file: 'src/backend/execution/flow/runFlow.ts', planned: 3540 },
  { file: 'src/backend/execution/flow/handlers/ModelHandler.ts', planned: 4375 },
  { file: 'src/backend/services/mcp/index.ts', planned: 3577 },
]);
/** Core paths a second person must be able to change (code health). */
export const CORE_PATHS = Object.freeze(['src/backend/execution', 'src/backend/services/mcp']);
/** Lint exceptions when the shrink-only list was introduced (#1426, counted 2026-11-25). */
export const LINT_EXCEPTION_BASELINE = Object.freeze({ counted: '2026-11-25', entries: 802 });

/** Release workflows and the installed-artifact check each one must run on the shipped form. */
export const INSTALLED_CHECKS = Object.freeze([
  { form: 'npm package', workflow: '.github/workflows/publish-npm.yml', marker: /packaged-acceptance\.mjs --form npm/ },
  { form: 'Docker image', workflow: '.github/workflows/publish-image.yml', marker: /packaged-acceptance\.mjs --form docker/ },
  { form: 'Windows installer', workflow: '.github/workflows/installer.yml', marker: /packaged-acceptance\.mjs --form checkout/ },
]);

const SOURCE_FILES = Object.freeze([
  ...CLAIM_FILES, 'docs/security/alert-triage.json', 'docs/quality/scorecard-foundation.json', 'docs/quality/scorecard-status.md',
  'docs/contributing/maintainership.md', 'eslint-suppressions.json', 'docs/pilots/product-fit/tracking-sheet.csv',
  'docs/pilots/product-fit/first-run-sheet.csv', ...INSTALLED_CHECKS.map((check) => check.workflow), ...HOT_SPOTS.map((spot) => spot.file),
]);

export const STATUS_LABELS = Object.freeze({ met: 'Met', 'not-met': 'Not met', 'not-checked': 'Not checked' });
export const KIND_LABELS = Object.freeze({
  'source-check': 'Source check',
  'shipped-artifact': 'Shipped-artifact check',
  'offline-simulation': 'Offline simulation',
  'live-provider': 'Live run with real models',
  'human-study': 'Human use',
  'security-review': 'Security review',
});

const oneLine = (text) => String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? 'unknown error';

// ---------------------------------------------------------------------------
// Inputs: files at the assessed commit

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 256 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
      });
  });
}

/** Read repository files from a commit (`ref`) or from the working tree. Missing files read as null. */
export function sourceReader({ ref = null, root = process.cwd(), run = runFile } = {}) {
  return {
    async commit() {
      return (await run('git', ['rev-parse', `${ref ?? 'HEAD'}^{commit}`], { cwd: root })).trim();
    },
    async clean() {
      if (ref) return true;
      return (await run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root })).trim() === '';
    },
    async read(file) {
      try {
        return ref ? await run('git', ['show', `${ref}:${file}`], { cwd: root }) : await readFile(path.join(root, file), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT' || /does not exist|exists on disk, but not in|bad revision/i.test(error?.stderr ?? '')) return null;
        throw error;
      }
    },
    async coreAuthors(since) {
      const out = await run('git', ['log', ref ?? 'HEAD', `--since=${since}`, '--no-merges', '--format=%an', '--', ...CORE_PATHS], { cwd: root });
      return out.split(/\r?\n/).filter(Boolean);
    },
  };
}

/** People named on the `Security responders:` line of SECURITY.md (GitHub handles; project accounts do not count). */
export function securityResponders(text) {
  const line = /^Security responders?:(.*)$/im.exec(text ?? '')?.[1] ?? '';
  return [...new Set([...line.matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/g)].map((match) => match[1].toLowerCase()))]
    .filter((login) => !PROJECT_ACCOUNTS.includes(login)).length;
}

const countLines = (text) => (text === null ? null : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0));

function pilotFromSheets(weeklyText, firstRunText) {
  const weekly = weeklyText === null ? [] : readSheet('tracking sheet', weeklyText, WEEKLY_COLUMNS, checkWeekly).rows;
  const firstRun = firstRunText === null ? [] : readSheet('first-run sheet', firstRunText, FIRST_RUN_COLUMNS, checkFirstRun).rows;
  const yes = (value) => /^(?:yes|y|true|1)$/i.test(String(value ?? '').trim());
  const number = (value) => Number.parseInt(value, 10) || 0;
  const active = (row) => row && yes(row.report_received) && yes(row.used_flujo) && number(row.finished_workflows) > 0;
  const testers = [...new Set(weekly.map((row) => row.tester))];
  const weeks = Math.max(0, ...weekly.map((row) => number(row.week)));
  const byTesterWeek = new Map(weekly.map((row) => [`${row.tester}/${number(row.week)}`, row]));
  const everyWeek = weeks === 0 ? 0 : testers.filter((id) => Array.from({ length: weeks }, (_, index) => byTesterWeek.get(`${id}/${index + 1}`)).every(active)).length;
  const novices = firstRun.filter((row) => yes(row.new_to_flujo));
  const fastNovices = novices.filter((row) => yes(row.finished) && !yes(row.help_given) && number(row.minutes) <= 15).length;
  return { testers: testers.length, weeks, activeEveryWeek: everyWeek, novices: novices.length, fastNovices };
}

/** Pull from the files only what the verdicts need; the result is stored with the page. */
export async function readSourceFacts(reader, { now }) {
  const files = {};
  for (const file of SOURCE_FILES) files[file] = await reader.read(file);
  const contract = files['docs/quality/scorecard-foundation.json'] ? JSON.parse(files['docs/quality/scorecard-foundation.json']) : null;
  const triage = files['docs/security/alert-triage.json'] ? JSON.parse(files['docs/security/alert-triage.json']) : null;
  const suppressions = files['eslint-suppressions.json'] ? JSON.parse(files['eslint-suppressions.json']) : null;
  const statusDate = /Checked on \*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(files['docs/quality/scorecard-status.md'] ?? '')?.[1] ?? null;
  const since = new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);
  const coreAuthors = await reader.coreAuthors(since);
  return {
    docsClaims: checkDocsClaims(Object.fromEntries(CLAIM_FILES.map((file) => [file, files[file] ?? undefined]))),
    installedChecks: INSTALLED_CHECKS.map((check) => ({
      form: check.form, workflow: check.workflow, present: check.marker.test(files[check.workflow] ?? ''),
    })),
    hotSpots: HOT_SPOTS.map((spot) => ({ ...spot, lines: countLines(files[spot.file]) })),
    lintExceptions: suppressions ? Object.values(suppressions)
      .reduce((sum, rules) => sum + Object.values(rules ?? {}).reduce((count, rule) => count + (rule?.count ?? 0), 0), 0) : null,
    triage,
    liveSpendLimitUsd: contract?.budgets?.find((budget) => budget.id === 'live-spend')?.limit ?? null,
    statusPageCheckedOn: statusDate,
    securityResponders: securityResponders(files['SECURITY.md']),
    independentSecurityReview: /^## Independent security reviews?\s*\n(?:(?!^## ).)*?^- \[[^\]]+\]\(https?:\/\/[^)]+\)/ms.test(files['SECURITY.md'] ?? ''),
    pilot: pilotFromSheets(files['docs/pilots/product-fit/tracking-sheet.csv'], files['docs/pilots/product-fit/first-run-sheet.csv']),
    coreChanges: {
      since,
      commits: coreAuthors.length,
      outsideAuthors: new Set(coreAuthors.filter((name) => !PROJECT_GIT_NAMES.includes(name.trim().toLowerCase()) && !/\[bot\]$/i.test(name))).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Inputs: public GitHub facts at the time of the assessment

/** Live answers through `gh`. Each fact that cannot be read becomes `{ error }` and its check says "Not checked". */
export function liveFacts({ repository = REPOSITORY, run = runFile, wait } = {}) {
  const repo = `repos/${repository}`;
  const lines = async (args) => (await withRetry(() => run('gh', args), { wait }))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return {
    async criticalIssues() {
      const found = new Map();
      for (const label of CRITICAL_LABELS) {
        for (const issue of await lines(['api', '--paginate', `${repo}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
          '--jq', '.[] | select(.pull_request == null) | {number, title} | @json'])) found.set(issue.number, issue);
      }
      return [...found.values()].sort((a, b) => a.number - b.number);
    },
    openCodeScanningAlerts: () => lines(['api', '--paginate', `${repo}/code-scanning/alerts?state=open&per_page=100`, '--jq',
      '.[] | {number, created_at, rule: {id: .rule.id, security_severity_level: .rule.security_severity_level, severity: .rule.severity}, '
      + 'most_recent_instance: {location: {path: .most_recent_instance.location.path}}} | @json']),
    async mergedPullRequestAuthors(since) {
      const query = encodeURIComponent(`repo:${repository} is:pr is:merged merged:>=${since}`);
      return lines(['api', '--paginate', `search/issues?q=${query}&per_page=100`, '--jq', '.items[] | {login: .user.login, type: .user.type} | @json']);
    },
    maintainers: () => lines(['api', '--paginate', `${repo}/collaborators?affiliation=all&per_page=100`, '--jq',
      '.[] | select(.permissions.push or .permissions.maintain or .permissions.admin) | {login, type} | @json']),
    async mainRules() {
      const rules = JSON.parse(await withRetry(() => run('gh', ['api', `${repo}/rules/branches/main`]), { wait }));
      const pull = rules.find((rule) => rule.type === 'pull_request');
      const checks = rules.find((rule) => rule.type === 'required_status_checks');
      return {
        pullRequest: Boolean(pull),
        approvals: pull?.parameters?.required_approving_review_count ?? 0,
        requiredChecks: checks?.parameters?.required_status_checks?.length ?? 0,
      };
    },
  };
}

/** Ask every fact; failures are kept as their one-line reason. People are stored as counts, never as names. */
export async function readLiveFacts(facts, { now }) {
  const since = new Date(now.getTime() - 90 * DAY_MS).toISOString().slice(0, 10);
  const ask = async (task) => {
    try { return await task(); } catch (error) { return { error: oneLine(error?.stderr || error?.message) }; }
  };
  const authors = await ask(() => facts.mergedPullRequestAuthors(since));
  const maintainers = await ask(() => facts.maintainers());
  const people = (list) => (Array.isArray(list) ? new Set(list.filter(isOutsideHuman).map((person) => person.login.toLowerCase())).size : null);
  return {
    criticalIssues: await ask(() => facts.criticalIssues()),
    openCodeScanningAlerts: await ask(() => facts.openCodeScanningAlerts()),
    mergeRules: await ask(() => facts.mainRules()),
    contributors: Array.isArray(authors) ? { since, mergedPullRequests: authors.length, outsideHumans: people(authors) } : authors,
    maintainers: Array.isArray(maintainers) ? { withWriteAccess: maintainers.length, outsideHumans: people(maintainers) } : maintainers,
  };
}

// ---------------------------------------------------------------------------
// Inputs: the offline Persona soak

/** Validate soak artifacts for a commit with the soak's own validator, and keep the numbers the contract names. */
export async function readSoak(directory, commit) {
  if (!directory) return null;
  try {
    const report = await validatePersonaSoakArtifacts({ directory, expectedCommit: commit, expectedMode: 'acceptance' });
    return { commit, passed: true, errors: [], ...soakNumbers(report) };
  } catch (error) {
    let report = null;
    try { report = JSON.parse(await readFile(path.join(directory, 'persona-soak.json'), 'utf8')); } catch { /* summarized below */ }
    const errors = String(error?.message ?? error).split(/\r?\n/).map((line) => line.replace(/^- /, '').trim())
      .filter((line) => line && !/^Persona soak artifact validation failed:?$/.test(line));
    return { commit: report?.runIdentity?.commitSha ?? null, passed: false, errors, ...(report ? soakNumbers(report) : {}) };
  }
}

function soakNumbers(report) {
  const metrics = Array.isArray(report?.metrics) ? report.metrics : [];
  const rss = metrics.map((metric) => metric.residentMemoryBytes).filter(Number.isFinite);
  return {
    days: report?.runIdentity?.days ?? null,
    activitiesPerDay: report?.runIdentity?.activitiesPerDay ?? null,
    measuredDays: metrics.length,
    maxAppendP95Ms: metrics.length ? Math.max(...metrics.map((metric) => metric.eventAppendP95Ms)) : null,
    maxRecallP95Ms: metrics.length ? Math.max(...metrics.map((metric) => metric.recallP95Ms)) : null,
    peakRssBytes: rss.length ? Math.max(...rss) : null,
    rssGrowthBytes: rss.length ? rss.at(-1) - rss[0] : null,
    startedAt: report?.runIdentity?.startedAt ?? null,
    endedAt: report?.runIdentity?.endedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Judge (pure: inputs in, verdicts out)

const evidenceCheck = (inputs, id) => inputs.evidence.checks.find((check) => check.id === id) ?? null;
const errorOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) && value.error ? value.error : null);
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function verdict(id, question, kind, status, evidence, source) {
  return { id, question, kind, status, evidence, source };
}

/** Every machine check, once. Rows and #578 points refer to them by id. */
function judgeChecks(inputs) {
  const { evidence, source, facts, soak, files } = inputs;
  const checks = new Map();
  const add = (...args) => { const item = verdict(...args); checks.set(item.id, item); };
  const releaseCommit = evidence.commit;
  const sameCommit = source.commit === releaseCommit;
  const sourceNote = sameCommit ? '' : ` (files read at ${source.commit.slice(0, 8)}, not the release commit)`;

  // Evidence quality
  const mismatches = evidence.checks.filter((check) => check.status === 'mismatch');
  const signed = ['source-commit', 'npm-provenance', 'npm-github-provenance', 'image-provenance', 'installer-provenance']
    .map((id) => evidenceCheck(inputs, id)).filter(Boolean);
  const unsigned = signed.filter((check) => check.status !== 'ok');
  add('evidence-revision-bound', 'Is every piece of evidence tied to the one release commit?', 'source-check',
    mismatches.length || unsigned.length ? 'not-met' : 'met',
    mismatches.length ? `Pieces contradict each other: ${mismatches.map((check) => check.piece).join(', ')}.`
      : unsigned.length ? `Not tied to the commit: ${unsigned.map((check) => `${check.piece} (${check.status})`).join(', ')}.`
        : `The tag, the npm packages, the image and the installer all name commit ${releaseCommit.slice(0, 8)} in signed build records; nothing contradicts.`,
    `release evidence page v${evidence.version}.md`);
  add('evidence-reproducible', 'Can anyone rebuild the evidence page from saved answers?', 'source-check',
    evidence.answersRecorded ? 'met' : 'not-met',
    evidence.answersRecorded ? `Every answer the collector read is saved in v${evidence.version}.answers.json; a test rebuilds the page from it and fails on any hand edit.`
      : 'No saved answers file sits next to the evidence page.',
    'scripts/collect-release-evidence.test.mjs');
  add('evidence-redacted', 'Is the evidence free of keys, tokens and personal contact data?', 'source-check',
    evidence.secretsFound.length ? 'not-met' : 'met',
    evidence.secretsFound.length ? `Found: ${evidence.secretsFound.join(', ')}.` : 'No token, key, password, private key or e-mail address in the page, its JSON or its saved answers.',
    'findSecrets in scripts/collect-release-evidence.mjs');

  // Critical problems
  const issues = facts.criticalIssues;
  add('critical-issues', 'Is any issue marked critical still open?', 'source-check',
    errorOf(issues) ? 'not-checked' : issues.length ? 'not-met' : 'met',
    errorOf(issues) ?? (issues.length ? `Open: ${issues.map((issue) => `#${issue.number}`).join(', ')}.` : `No open issue carries ${CRITICAL_LABELS.map((label) => `"${label}"`).join(', ')}.`),
    'GitHub issues');
  const alerts = evidence.alerts?.['code-scanning'];
  const deps = evidence.alerts?.dependabot;
  const seriousAtRelease = (value) => (value ? value.atRelease.critical + value.atRelease.high : null);
  add('alerts-at-release', 'Were critical or high security alerts open when the release shipped?', 'security-review',
    alerts === null || alerts === undefined ? 'not-checked' : seriousAtRelease(alerts) + (seriousAtRelease(deps) ?? 0) ? 'not-met' : 'met',
    alerts ? `Code scanning: ${alerts.atRelease.critical} critical and ${alerts.atRelease.high} high open at release`
      + `${deps ? `; dependencies: ${deps.atRelease.critical} critical and ${deps.atRelease.high} high` : '; dependency alerts not readable'}.` : 'Alert counts were not readable.',
    `release evidence page v${evidence.version}.md, "Security alerts"`);
  let triageStatus = errorOf(facts.openCodeScanningAlerts) ? 'not-checked' : 'not-met';
  let triageText = errorOf(facts.openCodeScanningAlerts) ?? 'There is no alert-triage.json at the assessed commit, so open alerts have no written reasons.';
  if (!errorOf(facts.openCodeScanningAlerts) && files.triage) {
    try {
      const result = evaluateSecurityResponse({ now: Date.parse(inputs.assessedAt), privateReporting: true, codeScanning: facts.openCodeScanningAlerts, triage: files.triage });
      const serious = result.rows.filter((row) => row.severity === 'critical' || row.severity === 'high');
      const open = serious.filter((row) => row.status !== 'triaged');
      triageStatus = open.length ? 'not-met' : 'met';
      triageText = open.length
        ? `${open.length} of ${serious.length} open critical or high code-scanning alerts have no current fix or written reason: ${open.map((row) => row.key).join(', ')}.`
        : `All ${serious.length} open critical or high code-scanning alerts have a fix or a written, dated reason in alert-triage.json.`;
    } catch (error) {
      triageStatus = 'not-met';
      triageText = `alert-triage.json is not valid: ${oneLine(error?.message)}`;
    }
  }
  add('alerts-triaged', 'Does every open critical or high alert have a fix or a written reason?', 'security-review', triageStatus, triageText + sourceNote,
    'docs/security/alert-triage.json, npm run check:security-response');

  // Docs
  const docs = files.docsClaims;
  const claimProblems = docs.filter((problem) => /^(?:claim|feature|missing)-/.test(problem.id));
  const visibilityProblems = docs.filter((problem) => /^(?:experimental|deferred|missing)-/.test(problem.id));
  add('docs-no-unsupported-claims', 'Do README, project status and SECURITY.md avoid claims the evidence does not back, and still list every audited feature?', 'source-check',
    claimProblems.length ? 'not-met' : 'met',
    (claimProblems.length ? claimProblems.map((problem) => problem.detail).join(' ') : 'No unsupported claim, and all audited features are still listed.') + sourceNote,
    'scripts/check-docs-claims.mjs');
  add('docs-limits-visible', 'Are experimental capabilities and unsupported profiles marked in README and project status?', 'source-check',
    visibilityProblems.length ? 'not-met' : 'met',
    (visibilityProblems.length ? visibilityProblems.map((problem) => problem.detail).join(' ') : 'Personas, Meetings and Waves are marked experimental; shared or team use is named as not supported.') + sourceNote,
    'scripts/check-docs-claims.mjs');
  const published = evidence.publishedAt.slice(0, 10);
  add('status-page-current', 'Was the scorecard status page checked on or after the release date?', 'source-check',
    files.statusPageCheckedOn && files.statusPageCheckedOn >= published ? 'met' : 'not-met',
    `docs/quality/scorecard-status.md says "Checked on ${files.statusPageCheckedOn ?? 'unknown'}"; the release was published ${published}.${sourceNote}`,
    'docs/quality/scorecard-status.md');

  // Release checks
  const required = ['ci-verify', 'ci-publish-npm', 'ci-publish-image', 'ci-installer', 'tests-ci', 'tests-isolated']
    .map((id) => evidenceCheck(inputs, id)).filter(Boolean);
  const failing = required.filter((check) => check.status !== 'ok');
  add('release-ci', 'Did the release workflows and source tests pass on the exact release commit?', 'source-check',
    failing.length ? 'not-met' : 'met',
    failing.length ? `Not passing: ${failing.map((check) => `${check.piece} (${check.detail})`).join('; ')}`
      : required.map((check) => `${check.piece}: ${check.detail}`).join(' '),
    `release evidence page v${evidence.version}.md, "CI on this exact commit"`);
  const fullChecks = ['ci-verify-full', 'ci-scorecard-source'].map((id) => evidenceCheck(inputs, id)).filter(Boolean);
  add('full-checks', 'Did the full pull-request checks and scorecard source checks run on the release commit?', 'source-check',
    fullChecks.length && fullChecks.every((check) => check.status === 'ok') ? 'met' : 'not-met',
    fullChecks.map((check) => `${check.piece}: ${check.detail}`).join(' ') || 'Not in the evidence.',
    '.github/workflows/release-evidence.yml starts both after each release');
  const sbom = evidenceCheck(inputs, 'npm-sbom-release');
  const provenance = ['npm-provenance', 'npm-github-provenance', 'image-provenance', 'installer-provenance', 'npm-sbom-signed', 'image-sbom']
    .map((id) => evidenceCheck(inputs, id)).filter(Boolean);
  const provenanceGaps = [...provenance, sbom].filter((check) => check && check.status !== 'ok');
  add('provenance', 'Do the npm packages, image and installer carry signed build records and dependency lists on the release page?', 'shipped-artifact',
    provenanceGaps.length ? 'not-met' : 'met',
    provenanceGaps.length ? provenanceGaps.map((check) => `${check.piece}: ${check.detail}`).join(' ') : 'All signed, and the SBOM and checksums are attached to the release page.',
    `release evidence page v${evidence.version}.md`);
  const signing = evidenceCheck(inputs, 'installer-code-signing');
  add('installer-code-signing', 'Is the Windows installer code-signed (Authenticode)?', 'shipped-artifact',
    !signing || signing.status === 'not-checked' ? 'not-checked' : signing.status === 'ok' ? 'met' : 'not-met',
    signing?.detail ?? 'Not in the evidence.', `release evidence page v${evidence.version}.md`);
  const installedRuns = files.installedChecks.map((check) => {
    const run = evidence.runs.find((item) => item.path === check.workflow);
    return { ...check, passed: Boolean(run) && run.conclusion === 'success' && run.failedJobs.length === 0 };
  });
  const installedMissing = installedRuns.filter((check) => !check.present || !check.passed);
  add('installed-acceptance', 'Did each shipped form (npm, image, installer) pass install, backup, restart, upgrade and restore checks in its release workflow?', 'shipped-artifact',
    installedMissing.length ? 'not-met' : 'met',
    installedMissing.length ? installedMissing.map((check) => `${check.form}: ${!check.present ? `${check.workflow} has no installed-artifact check at this commit` : 'its release workflow did not pass'}`).join('; ') + '.'
      : `All three forms ran scripts/packaged-acceptance.mjs in a passing release workflow.${sourceNote}`,
    'scripts/packaged-acceptance.mjs in publish-npm.yml, publish-image.yml, installer.yml');

  // Simulation and live runs
  const soakFor = source.commit;
  add('offline-soak', 'Does the full 28-day offline Persona soak pass its validator on the assessed commit (append p95 < 150 ms, peak memory <= 768 MB, growth <= 256 MB)?', 'offline-simulation',
    !soak ? 'not-met' : soak.passed && soak.commit === soakFor ? 'met' : 'not-met',
    !soak ? `No soak result for ${soakFor.slice(0, 8)}.`
      : `${soak.passed ? 'Passed' : 'Failed'} on ${soak.commit ? soak.commit.slice(0, 8) : 'an unknown commit'}: ${soak.measuredDays ?? 0} of ${soak.days ?? 28} days measured`
        + `${soak.maxAppendP95Ms !== null && soak.maxAppendP95Ms !== undefined ? `, worst daily append p95 ${soak.maxAppendP95Ms} ms, worst recall p95 ${soak.maxRecallP95Ms} ms, peak memory ${mb(soak.peakRssBytes)}, growth ${mb(soak.rssGrowthBytes)}` : ''}.`
        + `${soak.errors.length ? ` Problems: ${soak.errors.join('; ')}.` : ''}${soak.commit && soak.commit !== soakFor ? ' It ran on another commit.' : ''}`,
    'scripts/run-persona-soak.mjs, scripts/validate-persona-soak-artifacts.mjs');
  add('live-runs', 'Has a staged run with real models (bounded smoke, then 7 and 28 elapsed days) passed?', 'live-provider', 'not-met',
    `No live run is recorded. The contract's spend limit for such runs is ${files.liveSpendLimitUsd ?? 'unknown'} USD, so none may start; Personas stay marked experimental (checked above).`,
    'docs/quality/scorecard-foundation.json, budget live-spend');

  // People
  const pilot = files.pilot;
  add('pilot-weekly-users', 'Do ten or more independent people use FLUJO every week for eight weeks?', 'human-study',
    pilot.activeEveryWeek >= 10 && pilot.weeks >= 8 ? 'met' : 'not-met',
    `The pilot sheets list ${plural(pilot.testers, 'tester')} over ${plural(pilot.weeks, 'week')}; ${pilot.activeEveryWeek} used FLUJO in every week.`,
    'docs/pilots/product-fit/tracking-sheet.csv');
  add('pilot-first-run', 'Do eight of ten new users finish a first model-plus-MCP run within 15 minutes without help?', 'human-study',
    pilot.novices >= 10 && pilot.fastNovices / pilot.novices >= 0.8 ? 'met' : 'not-met',
    `The first-run sheet lists ${plural(pilot.novices, 'new user')}; ${pilot.fastNovices} finished within 15 minutes without help.`,
    'docs/pilots/product-fit/first-run-sheet.csv');
  const contributors = facts.contributors;
  add('outside-contributors', 'Did three or more people outside the project get changes merged in the last 90 days?', 'human-study',
    errorOf(contributors) ? 'not-checked' : contributors.outsideHumans >= 3 ? 'met' : 'not-met',
    errorOf(contributors) ?? `${contributors.mergedPullRequests} pull requests merged since ${contributors.since}; ${contributors.outsideHumans} by people outside the project (the owner, flujo-app and bots do not count).`,
    'GitHub search: merged pull requests');
  const maintainers = facts.maintainers;
  add('backup-maintainers', 'Do two or more people besides the owner hold write access to maintain and release?', 'human-study',
    errorOf(maintainers) ? 'not-checked' : maintainers.outsideHumans >= 2 ? 'met' : 'not-met',
    errorOf(maintainers) ?? `${maintainers.withWriteAccess} accounts can write; ${maintainers.outsideHumans} are people besides the owner.`,
    'GitHub collaborators');
  add('second-human-core-change', 'Did someone besides the owner and its agents change the execution or MCP core in the last 90 days?', 'human-study',
    files.coreChanges.outsideAuthors >= 1 ? 'met' : 'not-met',
    `${files.coreChanges.commits} commits changed ${CORE_PATHS.join(' or ')} since ${files.coreChanges.since}; ${files.coreChanges.outsideAuthors} came from someone outside the project.${sourceNote}`,
    'git log on the core paths');
  add('security-responder', 'Are a named security responder and a backup recorded?', 'human-study',
    files.securityResponders >= 2 ? 'met' : 'not-met',
    `SECURITY.md names ${files.securityResponders} ${files.securityResponders === 1 ? 'person' : 'people'} besides the project's own accounts on its "Security responders:" line; a responder and a backup make two.`,
    'SECURITY.md, line "Security responders: @handle, @handle"');
  add('independent-security-review', 'Has an independent threat-model review with zero open high or critical findings been published?', 'security-review',
    files.independentSecurityReview ? 'met' : 'not-met',
    files.independentSecurityReview ? 'SECURITY.md links a published independent review.' : 'SECURITY.md lists no independent security review.',
    'SECURITY.md, section "Independent security review"');

  // Code and repository
  const merge = facts.mergeRules;
  add('merge-gate', 'Do the merge rules on main stop a change whose checks fail?', 'source-check',
    errorOf(merge) ? 'not-checked' : merge.requiredChecks > 0 ? 'met' : 'not-met',
    errorOf(merge) ?? `main requires ${merge.pullRequest ? 'a pull request' : 'no pull request'}, ${plural(merge.approvals, 'approval')} and ${plural(merge.requiredChecks, 'passing check')}.`,
    'GitHub rules for main; docs/security/main-merge-rules.md');
  const grown = files.hotSpots.filter((spot) => spot.lines !== null && spot.lines > spot.planned);
  add('hot-spots', 'Are the hot-spot files the audit named no larger than when the split was planned?', 'source-check',
    grown.length ? 'not-met' : 'met',
    `${files.hotSpots.map((spot) => `${path.posix.basename(spot.file)} ${spot.lines ?? 'missing'} lines (planned at ${spot.planned})`).join(', ')}.${sourceNote}`,
    'scripts/release-reassessment.mjs HOT_SPOTS');
  add('lint-exceptions', 'Has the list of lint exceptions shrunk since it was introduced?', 'source-check',
    files.lintExceptions !== null && files.lintExceptions < LINT_EXCEPTION_BASELINE.entries ? 'met' : 'not-met',
    `${files.lintExceptions === null ? 'No eslint-suppressions.json at this commit' : `${files.lintExceptions} listed exceptions in eslint-suppressions.json`}; ${LINT_EXCEPTION_BASELINE.entries} on ${LINT_EXCEPTION_BASELINE.counted}.${sourceNote}`,
    'eslint-suppressions.json, npm run lint:ratchet');
  add('shared-profile', 'Does a shared or team profile pass two-user isolation and an independent security review?', 'security-review', 'not-met',
    'Shared or team use is not supported: multi-user ownership is deferred (#212), and the docs say so (checked above).',
    'docs/project-status.md');
  return checks;
}

/** The nine rows: original audit grade and the checks that make up its A− criteria. */
export const ROWS = Object.freeze([
  { id: 'product-fit', name: 'Idea / product fit', audit: 'A−', checks: ['pilot-weekly-users', 'pilot-first-run', 'docs-no-unsupported-claims'] },
  { id: 'feature-surface', name: 'Feature surface', audit: 'A−', checks: ['installed-acceptance', 'release-ci', 'docs-no-unsupported-claims'] },
  { id: 'engineering', name: 'Engineering discipline', audit: 'B+', checks: ['release-ci', 'full-checks', 'provenance', 'merge-gate', 'alerts-triaged', 'security-responder'] },
  { id: 'code-health', name: 'Code health', audit: 'B−', checks: ['hot-spots', 'lint-exceptions', 'second-human-core-change', 'critical-issues'] },
  { id: 'security', name: 'Security', audit: 'C+', checks: ['alerts-at-release', 'alerts-triaged', 'installer-code-signing', 'independent-security-review'] },
  { id: 'maturity', name: 'Maturity / stability', audit: 'C', checks: ['offline-soak', 'installed-acceptance', 'live-runs', 'critical-issues'] },
  { id: 'community', name: 'Community / bus factor', audit: 'D', checks: ['outside-contributors', 'backup-maintainers', 'second-human-core-change'] },
  { id: 'docs', name: 'Docs honesty', audit: 'A', checks: ['docs-no-unsupported-claims', 'docs-limits-visible', 'status-page-current', 'evidence-revision-bound'] },
  { id: 'production', name: 'Production readiness', audit: 'C−', checks: ['installed-acceptance', 'installer-code-signing', 'shared-profile'] },
]);

/** The acceptance points of #578, and the checks behind each. */
export const ACCEPTANCE = Object.freeze([
  { id: 'evidence', text: 'Evidence is reproducible, redacted, revision-bound and clearly separates source tests, shipped-artifact checks, simulations, live runs and human usability observations.', checks: ['evidence-reproducible', 'evidence-redacted', 'evidence-revision-bound'] },
  { id: 'no-critical', text: 'No open critical regression or unresolved high-severity finding exists within a claimed supported profile.', checks: ['critical-issues', 'alerts-at-release', 'alerts-triaged'] },
  { id: 'nine-rows', text: 'All nine scorecard dimensions are explicitly reassessed at A− or above; disagreements or unmet human/operational gates keep #563 open.', rows: true },
  { id: 'preserved', text: 'Product-fit/feature/docs grades are preserved without unsupported marketing claims or hidden scope reduction.', checks: ['docs-no-unsupported-claims'] },
  { id: 'limits-visible', text: 'Remaining experimental capabilities and deferred profiles are visible and accepted by the reviewer as consistent with the rubric.', checks: ['docs-limits-visible'] },
]);

/** Scope items of #578 that are not acceptance points but still need a verdict. */
export const SCOPE = Object.freeze([
  { id: 'reconcile', text: 'Reconcile source, npm/container/installer provenance, full CI and installed-artifact acceptance.', checks: ['release-ci', 'full-checks', 'provenance', 'installed-acceptance'] },
  { id: 'soak', text: 'The full offline soak and validator pass at the assessed revision with unchanged limits.', checks: ['offline-soak'] },
  { id: 'live', text: 'Stage live-provider acceptance from a bounded smoke to 7 and 28 elapsed days.', checks: ['live-runs'] },
  { id: 'docs-current', text: 'README, project status and security docs updated from the evidence.', checks: ['status-page-current', 'docs-limits-visible'] },
]);

const allMet = (items) => items.every((item) => item.status === 'met');

export function judge(inputs) {
  return summarize(judgeChecks(inputs));
}

/** Roll checks up into rows, #578 acceptance points and scope items. `checks` maps id to verdict. */
export function summarize(checks) {
  const pick = (ids) => ids.map((id) => checks.get(id));
  const rows = ROWS.map((row) => {
    const rowChecks = pick(row.checks);
    const met = allMet(rowChecks);
    const preservedRow = ['A−', 'A'].includes(row.audit);
    return {
      id: row.id, name: row.name, audit: row.audit, checks: row.checks, aMinusShown: met,
      verdict: met ? 'A− criteria met' : preservedRow ? `${row.audit} not confirmed: ${rowChecks.filter((check) => check.status !== 'met').length} of ${rowChecks.length} checks not met`
        : `Below A−: held at the audit grade ${row.audit} until every check is met`,
    };
  });
  const acceptance = ACCEPTANCE.map((point) => {
    if (point.rows) {
      const shown = rows.filter((row) => row.aMinusShown).length;
      return { id: point.id, text: point.text, status: shown === rows.length ? 'met' : 'not-met', detail: `${shown} of ${rows.length} rows show their A− criteria met.` };
    }
    const items = pick(point.checks);
    return { id: point.id, text: point.text, status: allMet(items) ? 'met' : items.some((item) => item.status === 'not-met') ? 'not-met' : 'not-checked', checks: point.checks };
  });
  const scope = SCOPE.map((item) => {
    const items = pick(item.checks);
    return { id: item.id, text: item.text, status: allMet(items) ? 'met' : items.some((check) => check.status === 'not-met') ? 'not-met' : 'not-checked', checks: item.checks };
  });
  return { checks: [...checks.values()], rows, acceptance, scope };
}

// ---------------------------------------------------------------------------
// Render (pure)

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
const when = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'unknown');

export function renderReassessmentPage(result) {
  const { inputs, verdicts } = result;
  const byId = new Map(verdicts.checks.map((check) => [check.id, check]));
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [status, verdicts.checks.filter((check) => check.status === status).length]));
  const sameCommit = inputs.source.commit === inputs.evidence.commit;
  const kinds = Object.keys(KIND_LABELS).map((kind) => {
    const items = verdicts.checks.filter((check) => check.kind === kind);
    return [KIND_LABELS[kind], `${items.filter((check) => check.status === 'met').length} of ${items.length} met`, items.map((check) => check.id).join(', ')];
  });
  const lines = [
    `# Release reassessment: FLUJO ${inputs.evidence.version}`,
    '',
    `<!-- Generated by scripts/release-reassessment.mjs from v${inputs.evidence.version}.reassessment.json. Do not edit by hand: run the command below again. -->`,
    '',
    `Assessed on ${when(inputs.assessedAt)} by \`scripts/release-reassessment.mjs\`, an automated`,
    'reviewer: it applies the A− criteria of the [scorecard foundation contract](../scorecard-foundation.md)',
    `and the acceptance points of [#578](https://github.com/${REPOSITORY}/issues/578) to the`,
    `[release evidence](v${inputs.evidence.version}.md), files at the assessed commit and public GitHub facts.`,
    'It runs after every release (`.github/workflows/release-evidence.yml`). It is a machine verdict,',
    'not a human opinion; a check that needs people reads where their results are recorded and stays',
    '"Not met" until they exist.',
    '',
    `- Release: ${inputs.evidence.tag}, commit \`${inputs.evidence.commit}\`, published ${when(inputs.evidence.publishedAt)}`,
    `- Files read at: \`${inputs.source.commit}\`${inputs.source.ref ? ` (\`${inputs.source.ref}\`)` : ' (working tree)'}${sameCommit ? ', the release commit' : ', **not the release commit**: file checks describe that commit, artifact checks describe the release'}`,
    `- Offline soak: ${inputs.soak ? `artifacts for \`${inputs.soak.commit ?? 'unknown'}\`` : 'none supplied'}`,
    '',
    `Re-create it: \`${inputs.command}\``,
    '',
    '## Verdict',
    '',
    `${counts.met} checks met, ${counts['not-met']} not met, ${counts['not-checked']} not checked.`,
    '',
    table(['#578 acceptance point', 'Verdict', 'Checks'], verdicts.acceptance.map((point) => [point.text, STATUS_LABELS[point.status],
      point.checks ? point.checks.map((id) => `${id}: ${STATUS_LABELS[byId.get(id).status]}`).join('; ') : point.detail])),
    '',
    table(['Scope item', 'Verdict', 'Checks'], verdicts.scope.map((item) => [item.text, STATUS_LABELS[item.status],
      item.checks.map((id) => `${id}: ${STATUS_LABELS[byId.get(id).status]}`).join('; ')])),
    '',
    '## The nine rows',
    '',
    'A row reaches A− only when every check behind its A− criteria is met. Until then it',
    'keeps the grade of the external audit; rows that started at A− or A are "not confirmed".',
    '',
    table(['Row', 'Audit grade', 'Verdict', 'Checks'], verdicts.rows.map((row) => [row.name, row.audit, row.verdict,
      row.checks.map((id) => `${id}: ${STATUS_LABELS[byId.get(id).status]}`).join('; ')])),
    '',
    '## Kinds of evidence, kept apart',
    '',
    table(['Kind', 'Result', 'Checks'], kinds),
    '',
    '## Every check',
    '',
    table(['Check', 'Question', 'Kind', 'Result', 'Evidence', 'Source'], verdicts.checks.map((check) => [check.id, check.question,
      KIND_LABELS[check.kind], STATUS_LABELS[check.status], check.evidence, check.source])),
    '',
    '## What this page does not do',
    '',
    '- It awards no letter grade between the audit grade and A−; the',
    '  [reassessment page](../independent-reassessment.md) records the reviewer\'s reasons.',
    '- It does not read private data: people are counted from public GitHub data and the',
    '  pilot sheets, never named.',
    '- Checks that need people, elapsed time or money (pilot users, outside maintainers,',
    '  live model runs, an outside security review) stay "Not met" until their results are',
    '  recorded where the check reads them.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Command line

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = { '--evidence': 'evidence', '--source': 'source', '--soak': 'soak', '--out': 'out', '--replay': 'replay' }[argv[index]];
    const value = argv[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error('Usage: release-reassessment.mjs --evidence <v<x.y.z>.json> [--source <git ref>] [--soak <dir>] [--out <dir>] | --replay <v<x.y.z>.reassessment.json>');
    }
    options[key] = value;
    index += 1;
  }
  if (!options.evidence && !options.replay) throw new Error('Missing --evidence <v<x.y.z>.json> or --replay <file>.');
  return options;
}

/** Read every input once; the result holds them so the verdicts can be judged again offline. */
export async function gatherInputs({ evidencePath, sourceRef = null, soakDirectory = null, now = new Date(), facts = liveFacts(), reader = sourceReader({ ref: sourceRef }) }) {
  const evidenceText = await readFile(evidencePath, 'utf8');
  const evidence = JSON.parse(evidenceText);
  if (!SHA.test(evidence.source?.commit ?? '')) throw new Error(`${evidencePath} names no release commit.`);
  const answersPath = path.join(path.dirname(evidencePath), `v${evidence.version}.answers.json`);
  const pagePath = path.join(path.dirname(evidencePath), `v${evidence.version}.md`);
  const optional = async (file) => { try { return await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; } };
  const answersText = await optional(answersPath);
  const pageText = await optional(pagePath);
  const commit = await reader.commit();
  if (!sourceRef && !(await reader.clean())) throw new Error('The working tree has uncommitted changes; commit them or pass --source <ref>.');
  const command = ['npm run reassess:release --', '--evidence', evidencePath.split(path.sep).join('/'),
    ...(sourceRef ? ['--source', sourceRef] : []), ...(soakDirectory ? ['--soak', '<soak-artifacts>'] : [])].join(' ');
  return {
    schemaVersion: SCHEMA_VERSION,
    assessedAt: now.toISOString(),
    command,
    source: { ref: sourceRef, commit },
    evidence: {
      version: evidence.version, tag: evidence.tag, commit: evidence.source.commit, publishedAt: evidence.release.publishedAt,
      collectedAt: evidence.collectedAt, answersRecorded: answersText !== null,
      secretsFound: findSecrets([evidenceText, answersText ?? '', pageText ?? ''].join('\n')),
      checks: evidence.checks.map(({ id, piece, status, detail }) => ({ id, piece, status, detail })),
      runs: evidence.ci.runs.map((run) => ({ path: run.path, conclusion: run.conclusion, failedJobs: run.jobs?.failed ?? [] })),
      alerts: evidence.alerts,
    },
    files: await readSourceFacts(reader, { now }),
    facts: await readLiveFacts(facts, { now }),
    soak: await readSoak(soakDirectory, commit),
  };
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const options = parseArguments(argv);
  let inputs;
  if (options.replay) {
    inputs = JSON.parse(await readFile(options.replay, 'utf8')).inputs;
  } else {
    inputs = await gatherInputs({ evidencePath: options.evidence, sourceRef: options.source ?? null, soakDirectory: options.soak ?? null });
  }
  const result = { inputs, verdicts: judge(inputs) };
  const page = renderReassessmentPage(result);
  if (options.out) {
    await mkdir(options.out, { recursive: true });
    await writeFile(path.join(options.out, `v${inputs.evidence.version}.reassessment.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(options.out, `v${inputs.evidence.version}.reassessment.md`), page);
    log(`Wrote v${inputs.evidence.version}.reassessment.md and .json to ${options.out}`);
  } else {
    log(page);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`Release reassessment could not run: ${error.message}`);
    process.exitCode = 1;
  });
}
