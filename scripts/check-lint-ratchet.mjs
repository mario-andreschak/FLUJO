#!/usr/bin/env node
// eslint-suppressions.json lists lint problems that existed before a rule was
// switched on. ESLint already fails when an entry is no longer needed, so the
// list shrinks as code is fixed. This check stops it from growing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPRESSIONS_FILE = 'eslint-suppressions.json';

/** Reads `git diff --name-status -M` output: renamed files (new path -> old path) and added files. */
export function parseNameStatus(nameStatus) {
  const renames = new Map();
  const added = new Set();
  for (const line of nameStatus.split('\n')) {
    const [status, from, to] = line.split('\t');
    if (status?.startsWith('R') && from && to) renames.set(to, from);
    if (status === 'A' && from) added.add(from);
  }
  return { renames, added };
}

/** Lists suppressions for files this branch adds. New code is never grandfathered, even when a rule first arrives. */
export function findNewFileEntries(current, added) {
  return Object.entries(current)
    .filter(([file]) => added.has(file))
    .flatMap(([file, rules]) => Object.entries(rules).map(([rule, { count }]) => ({ file, rule, allowed: 0, count })));
}

/** Lists every file and rule whose suppressed count is higher than on the base. */
export function findGrowth(base, current, renames = new Map()) {
  const growth = [];
  for (const [file, rules] of Object.entries(current)) {
    const before = base[file] ?? base[renames.get(file)] ?? {};
    for (const [rule, { count }] of Object.entries(rules)) {
      const allowed = before[rule]?.count ?? 0;
      if (count > allowed) growth.push({ file, rule, allowed, count });
    }
  }
  return growth;
}

export function describeGrowth(growth) {
  return [
    `${SUPPRESSIONS_FILE} grew. It lists old code only and may only shrink:`,
    ...growth.map(({ file, rule, allowed, count }) => `  ${file}  ${rule}  ${allowed} -> ${count}`),
    '',
    'Fix the new code instead; each rule\'s message says how. Do not run eslint with',
    '--suppress-all or --suppress-rule. A real exception goes on the line itself:',
    '  // eslint-disable-next-line <rule> -- <why this case is different>',
    'See "Corrections become checks" in AGENTS.md.',
  ].join('\n');
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function resolveBase(cwd, env) {
  if (env.LINT_RATCHET_BASE) return env.LINT_RATCHET_BASE;
  // CI checks out the PR merge commit or the pushed main commit: its first parent is the base.
  if (env.GITHUB_ACTIONS === 'true') return git(['rev-parse', 'HEAD^1'], cwd).trim();
  return git(['merge-base', 'HEAD', 'origin/main'], cwd).trim();
}

export function run({ cwd = process.cwd(), env = process.env, log = console.log, error = console.error } = {}) {
  let base;
  try {
    base = resolveBase(cwd, env);
  } catch (cause) {
    if (env.GITHUB_ACTIONS === 'true') {
      error(`Cannot find the base commit to compare ${SUPPRESSIONS_FILE} with. Check out at least two commits (fetch-depth: 2).\n${cause.message}`);
      return 1;
    }
    log(`Skipped: no base commit to compare ${SUPPRESSIONS_FILE} with (fetch origin/main to enable this check).`);
    return 0;
  }
  const current = JSON.parse(readFileSync(path.join(cwd, SUPPRESSIONS_FILE), 'utf8'));
  const { renames, added } = parseNameStatus(git(['diff', '-M', '--name-status', base], cwd));
  let before;
  try {
    before = JSON.parse(git(['show', `${base}:${SUPPRESSIONS_FILE}`], cwd));
  } catch {
    before = undefined;
  }
  const growth = before ? findGrowth(before, current, renames) : findNewFileEntries(current, added);
  if (growth.length) {
    error(describeGrowth(growth));
    return 1;
  }
  const count = (list) => Object.values(list).reduce((sum, rules) => sum + Object.values(rules).reduce((n, { count: c }) => n + c, 0), 0);
  log(`Lint ratchet holds: ${count(current)} known problems (base ${before ? count(before) : 'has no list yet'}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
