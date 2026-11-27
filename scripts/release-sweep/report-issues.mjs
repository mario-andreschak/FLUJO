#!/usr/bin/env node
// Turns the problems in a sweep report into GitHub issues: one per distinct problem, matched to open
// issues by fingerprint. Dry run unless --file is given; how it fits together: docs/release-sweep.md.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../flujo-drive.mjs';
import { DEFAULT_MAX_NEW, SWEEP_LABEL, planIssues, renderPlan } from './issues.mjs';
import { problemsFromReport } from './problems.mjs';

export const USAGE = `Usage: node scripts/release-sweep/report-issues.mjs --report REPORT.json [options]

Plans one GitHub issue per distinct problem in a release sweep report and prints the plan.
Nothing is filed unless --file is given.

  --file              Really file: create new issues and comment on open ones (needs gh signed in).
  --repo OWNER/NAME   Repository (default: $GITHUB_REPOSITORY, else the current gh repository).
  --run-url URL       Link to the sweep's files (the CI run), shown in each issue.
  --max-new N         New issues per run (default ${DEFAULT_MAX_NEW}); the rest wait for the next run.
  --offline           Dry run without reading open issues.
  --out FILE          Where to write the plan (default: issues-plan.md next to the report).

Exit code 0 when the plan was made (and filed with --file), 2 when it could not be.`;

/** Runs gh and returns its output, or throws with gh's own message. */
export function runGh(args, input) {
  const result = spawnSync('gh', args, { encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`gh could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

export function readOpenIssues(repo, gh = runGh) {
  const output = gh(['issue', 'list', '--repo', repo, '--label', SWEEP_LABEL, '--state', 'open', '--limit', '1000', '--json', 'number,title,body,comments']);
  return JSON.parse(output || '[]');
}

function ensureLabel(repo, gh) {
  const labels = JSON.parse(gh(['label', 'list', '--repo', repo, '--limit', '1000', '--json', 'name']) || '[]');
  if (!labels.some((label) => label.name === SWEEP_LABEL)) {
    gh(['label', 'create', SWEEP_LABEL, '--repo', repo, '--color', 'C5DEF5', '--description', 'Found by the release sweep (docs/release-sweep.md)']);
  }
}

export function fileActions(actions, repo, gh = runGh, log = console.log) {
  if (actions.some((action) => action.type === 'create')) ensureLabel(repo, gh);
  for (const action of actions) {
    if (action.type === 'create') {
      const url = gh(['issue', 'create', '--repo', repo, '--title', action.issue.title, '--body-file', '-',
        ...action.issue.labels.flatMap((label) => ['--label', label])], action.issue.body).trim();
      log(`Filed ${url}: ${action.issue.title}`);
    } else if (action.type === 'comment') {
      gh(['issue', 'comment', String(action.number), '--repo', repo, '--body-file', '-'], action.body);
      log(`Commented on #${action.number}: ${action.problem.title}`);
    }
  }
}

export async function main(argv = process.argv.slice(2), { log = console.log, gh = runGh, env = process.env } = {}) {
  const { options } = parseArgs(['report', ...argv]);
  if (options.help || typeof options.report !== 'string') {
    log(USAGE);
    return options.help ? 0 : 2;
  }
  const report = JSON.parse(readFileSync(options.report, 'utf8'));
  if (report.tool !== 'release-sweep') throw new Error(`${options.report} is not a release sweep report.`);
  const dryRun = options.file !== true;
  const maxNew = options['max-new'] === undefined ? DEFAULT_MAX_NEW : Number(options['max-new']);
  if (!Number.isInteger(maxNew) || maxNew < 0) throw new Error('--max-new must be a whole number.');
  if (!dryRun && options.offline) throw new Error('--offline only works for a dry run: filing needs the open issues to avoid duplicates.');
  let repo = typeof options.repo === 'string' ? options.repo : env.GITHUB_REPOSITORY;

  const problems = problemsFromReport(report);
  let openIssues = [];
  if (!options.offline && problems.length) {
    try {
      repo ??= JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
      openIssues = readOpenIssues(repo, gh);
    } catch (error) {
      if (!dryRun) throw error;
      log(`! Could not read open issues (${error.message.split('\n')[0]}); planning as if none were open.`);
    }
  }
  const actions = planIssues(problems, openIssues, {
    version: report.target?.version, repo, runUrl: typeof options['run-url'] === 'string' ? options['run-url'] : undefined, maxNew,
  });
  const plan = renderPlan(actions, { dryRun });
  const out = typeof options.out === 'string' ? options.out : path.join(path.dirname(options.report), 'issues-plan.md');
  writeFileSync(out, plan);
  log(plan);
  log(`Plan: ${out}`);
  if (!dryRun) fileActions(actions, repo, gh, log);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
