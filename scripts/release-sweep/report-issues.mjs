#!/usr/bin/env node
// Turns the problems in a sweep report into GitHub issues: one per distinct problem, matched to existing
// issues by fingerprint. Dry run unless --file is given; how it fits together: docs/release-sweep.md.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../flujo-drive.mjs';
import { MAX_NEW_ISSUES, SWEEP_LABEL, planIssues, renderPlan } from './issues.mjs';
import { problemsFromReport, runnerNotes } from './problems.mjs';

const READ_ATTEMPTS = 4;
const WRITE_GAP_MS = 1_000;

export const USAGE = `Usage: node scripts/release-sweep/report-issues.mjs --report REPORT.json [options]

Plans one GitHub issue per distinct problem in a release sweep report and prints the plan.
Nothing is filed unless --file is given. At most ${MAX_NEW_ISSUES} new problem issues per run; the rest wait in one
summary issue that later runs work down.

  --file              Really file: create new issues, comment on known ones (needs gh signed in).
  --repo OWNER/NAME   Repository (default: $GITHUB_REPOSITORY, else the current gh repository).
  --run-url URL       Link to the CI run that made the report.
  --evidence-url URL  Direct link to the screenshots and snapshots (default: the run link).
  --offline           Dry run without reading the existing sweep issues.
  --out FILE          Where to write the plan (default: issues-plan.md next to the report).

Exit code 0 when the plan was made (and filed with --file), 2 when it could not be.`;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** GitHub answers that are worth asking again: its own hiccups, rate limits and dropped connections. */
export function isTransientGhError(message) {
  return /HTTP 5\d\d|HTTP 429|rate limit|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|connection reset|unexpected EOF|TLS handshake/i.test(String(message ?? ''));
}

/** Runs `read` up to `attempts` times while it fails with a transient GitHub error, waiting longer each time. */
export function retryTransient(read, { attempts = READ_ATTEMPTS, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return read();
    } catch (error) {
      if (attempt >= attempts || !isTransientGhError(error.message)) throw error;
      sleep(2_000 * 2 ** (attempt - 1));
    }
  }
}

/** Runs gh and returns its output, or throws with gh's own message. */
export function runGh(args, input) {
  const result = spawnSync('gh', args, { encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`gh could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** Open and closed sweep issues: the planner matches problems to them by fingerprint. */
export function readSweepIssues(repo, gh = runGh, sleep = sleepSync) {
  const output = retryTransient(() => gh(['issue', 'list', '--repo', repo, '--label', SWEEP_LABEL, '--state', 'all', '--limit', '1000',
    '--json', 'number,state,stateReason,closedAt,title,body,comments']), { sleep });
  return JSON.parse(output || '[]');
}

/** When the swept release's commit was made, from its v<version> tag; undefined when there is no such tag. */
export function releasedAt(repo, version, gh = runGh, sleep = sleepSync) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version ?? ''))) return undefined;
  try {
    const date = retryTransient(() => gh(['api', `repos/${repo}/commits/v${version}`, '--jq', '.commit.committer.date']), { sleep }).trim();
    return Number.isNaN(Date.parse(date)) ? undefined : date;
  } catch (error) {
    if (/HTTP 404|HTTP 422|No commit found/i.test(error.message)) return undefined;
    throw error;
  }
}

function ensureLabel(repo, gh, sleep) {
  const labels = JSON.parse(retryTransient(() => gh(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']), { sleep }) || '[]');
  if (!labels.some((label) => label.name === SWEEP_LABEL)) {
    gh(['label', 'create', SWEEP_LABEL, '--repo', repo, '--color', 'C5DEF5', '--description', 'Found by the release sweep (docs/release-sweep.md)']);
  }
}

/**
 * Carries out the plan. Writes are not repeated within a run (GitHub may have done one that reported an error),
 * so a failed write is logged and the rest go on; the next sweep finds every issue by its fingerprint and does
 * what is still missing, so nothing is filed twice.
 */
export function fileActions(actions, repo, { gh = runGh, log = console.log, sleep = sleepSync } = {}) {
  const writes = actions.filter((action) => ['create', 'comment', 'close'].includes(action.type));
  if (!writes.length) return;
  if (writes.some((action) => action.type === 'create')) ensureLabel(repo, gh, sleep);
  const failed = [];
  for (const [index, action] of writes.entries()) {
    if (index) sleep(WRITE_GAP_MS);
    try {
      if (action.type === 'create') {
        const url = gh(['issue', 'create', '--repo', repo, '--title', action.issue.title, '--body-file', '-',
          ...action.issue.labels.flatMap((label) => ['--label', label])], action.issue.body).trim();
        log(`Filed ${url}: ${action.issue.title}`);
      } else if (action.type === 'comment') {
        gh(['issue', 'comment', String(action.number), '--repo', repo, '--body-file', '-'], action.body);
        log(`Commented on #${action.number}: ${action.title}`);
      } else {
        gh(['issue', 'close', String(action.number), '--repo', repo, '--reason', 'completed', '--comment', action.body]);
        log(`Closed #${action.number}: ${action.title}`);
      }
    } catch (error) {
      failed.push(`${action.type} ${action.number ? `#${action.number}` : action.title}: ${error.message.split('\n')[0]}`);
      log(`! Could not ${action.type} ${action.number ? `#${action.number}` : `"${action.title}"`}: ${error.message.split('\n')[0]}`);
    }
  }
  if (failed.length) {
    throw new Error(`${failed.length} of ${writes.length} GitHub writes failed; the next sweep does what is missing without filing twice.\n${failed.join('\n')}`);
  }
}

/** True when the sweep reached every runnable step, so a problem it did not see is really gone. */
export function walkedEverything(report) {
  return ['passed', 'problems'].includes(report.result) && !report.instanceProblem
    && (report.entries ?? []).every((entry) => (entry.checks ?? []).every((check) => !['not-run', 'runner'].includes(check.status)));
}

export async function main(argv = process.argv.slice(2), { log = console.log, gh = runGh, env = process.env, sleep = sleepSync } = {}) {
  const { options } = parseArgs(['report', ...argv]);
  if (options.help || typeof options.report !== 'string') {
    log(USAGE);
    return options.help ? 0 : 2;
  }
  const report = JSON.parse(readFileSync(options.report, 'utf8'));
  if (report.tool !== 'release-sweep') throw new Error(`${options.report} is not a release sweep report.`);
  const dryRun = options.file !== true;
  if (!dryRun && options.offline) throw new Error('--offline only works for a dry run: filing needs the existing issues to avoid duplicates.');
  const text = (name) => (typeof options[name] === 'string' && options[name] ? options[name] : undefined);
  let repo = text('repo') ?? env.GITHUB_REPOSITORY;
  const version = report.target?.version;

  const problems = problemsFromReport(report);
  const walkComplete = walkedEverything(report);
  let knownIssues = [];
  let released;
  if (!options.offline && (problems.length || walkComplete)) {
    try {
      repo ??= JSON.parse(retryTransient(() => gh(['repo', 'view', '--json', 'nameWithOwner']), { sleep })).nameWithOwner;
      knownIssues = readSweepIssues(repo, gh, sleep);
      if (problems.length && report.target?.kind === 'release') released = releasedAt(repo, version, gh, sleep);
    } catch (error) {
      if (!dryRun) throw error;
      log(`! Could not read the sweep's issues (${error.message.split('\n')[0]}); planning as if there were none.`);
    }
  }
  const actions = planIssues(problems, knownIssues, {
    version, repo, runUrl: text('run-url'), evidenceUrl: text('evidence-url'), releasedAt: released, walkComplete,
  });
  const secondTry = (report.entries ?? []).flatMap((entry) => entry.checks ?? []).filter((check) => check.status === 'passed' && check.firstError);
  const plan = renderPlan(actions, { dryRun, runnerNotes: runnerNotes(report), secondTry });
  const out = text('out') ?? path.join(path.dirname(options.report), 'issues-plan.md');
  writeFileSync(out, plan);
  log(plan);
  log(`Plan: ${out}`);
  if (!dryRun) fileActions(actions, repo, { gh, log, sleep });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
