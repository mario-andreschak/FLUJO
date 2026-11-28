#!/usr/bin/env node
// Runs every step file the feature map names (docs/feature-map/steps/*.json) on a throwaway FLUJO
// from the production build, the way a person clicks through it. Steps a fresh instance cannot run
// get their precondition here first: a local stand-in model, a launch setting, saved agents, a
// Persona or a package from a local stand-in registry. What each file checks is written next to
// the bullet that names it in docs/feature-map/. The release sweep runs the same files on every
// release, except those that need a precondition.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, loadChromium, parseArgs, parseViewport, runStep, save } from '../flujo-drive.mjs';
import { startProductionFlujo } from '../first-journey/production.mjs';
import { startStubModel } from '../first-journey/stub-model.mjs';
import { loadPlan, slug } from '../release-sweep/steps.mjs';
import { SETUPS } from './setups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MAP_DIR = path.join(ROOT, 'docs/feature-map');
const EVIDENCE = 'feature-steps';

export const USAGE = `Usage: node scripts/feature-steps/run.mjs [--only <entry>[,<entry>]] [--viewport WxH]

Runs every step file named in docs/feature-map/ (docs/feature-map/steps/*.json) on throwaway FLUJO
instances started from the production build ("npm run build" first), each with an empty data folder
on a free port (never 4200), and stops and deletes them at the end. Steps that need something a
fresh FLUJO lacks get it first (see scripts/feature-steps/setups.mjs). A screenshot and an
accessibility snapshot of every check, and report.json, are saved under
${path.join(EVIDENCE_DIR, EVIDENCE)}. Exit code 0 means every check passed without errors on the page.`;

/**
 * The checks this runner owns: every bullet that names a step file. A bullet the release sweep
 * cannot run on a fresh FLUJO ("needs …") must have a setup here, or the run fails and says so.
 */
export function stepFileChecks(plan, setups = SETUPS) {
  const checks = [];
  const problems = [];
  for (const entry of plan) {
    for (const check of entry.checks) {
      if (!check.stepFile) continue;
      const file = path.posix.basename(check.stepFile);
      const setup = setups[file] ?? {};
      if (check.status === 'manual') problems.push(`${check.id}: names ${check.stepFile} but its bullet is not a steps command (${check.reason}).`);
      else if (check.status === 'needs' && !setup.provides) {
        problems.push(`${check.id} ${check.reason}, and scripts/feature-steps/setups.mjs has no setup for ${file}. Add one that provides it.`);
      } else if (!check.steps) problems.push(`${check.id}: ${check.stepFile} has no steps command to run (${check.reason ?? check.status}).`);
      else checks.push({ ...check, file, setup });
    }
  }
  return { checks, problems };
}

/** Checks that need the same launch settings share one FLUJO; the plain one comes first. */
export function instanceGroups(checks) {
  const groups = new Map();
  for (const check of checks) {
    const env = check.setup.env ?? {};
    const key = JSON.stringify(Object.entries(env).sort());
    if (!groups.has(key)) groups.set(key, { env, checks: [] });
    groups.get(key).checks.push(check);
  }
  return [...groups.values()].sort((left, right) => Object.keys(left.env).length - Object.keys(right.env).length);
}

async function runOne(browser, check, context) {
  const { baseUrl, viewport, log } = context;
  const evidence = path.join(EVIDENCE, check.entry, slug(check.label));
  const result = { id: check.id, file: check.stepFile, ok: false, problems: [] };
  const started = Date.now();
  const browserContext = await browser.newContext({ viewport, locale: 'en-US' });
  await browserContext.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
  const page = await browserContext.newPage();
  page.on('pageerror', (error) => result.problems.push(`page error: ${error.message.split('\n')[0]}`));
  page.on('console', (message) => { if (message.type() === 'error') result.problems.push(`console error: ${message.text().slice(0, 300)}`); });
  let index = 0;
  let prepared = {};
  try {
    prepared = (check.setup.before ? await check.setup.before({ ...context, check }) : undefined) ?? {};
    const [visit, ...steps] = check.steps;
    const all = [{ ...visit, route: prepared?.route ?? visit.route }, ...steps];
    for (; index < all.length; index += 1) await runStep(page, all[index], baseUrl, () => {});
    if (check.setup.after) await check.setup.after({ ...context, check, page, prepared });
    await save(page, 'shot', `${evidence}.png`, () => {});
    await save(page, 'aria', `${evidence}.yml`, () => {});
    const pageErrors = result.problems.filter((problem) => problem.startsWith('page error:'));
    if (pageErrors.length) throw new Error(`${pageErrors.length} error(s) crashed code on the page: ${pageErrors[0]}`);
    result.ok = true;
  } catch (error) {
    result.error = String(error.message ?? error).split('\n')[0].slice(0, 500);
    result.failedStep = index;
    await save(page, 'shot', `${evidence}-failed.png`, () => {}).catch(() => undefined);
    await save(page, 'aria', `${evidence}-failed.yml`, () => {}).catch(() => undefined);
  } finally {
    await browserContext.close().catch(() => undefined);
    await Promise.resolve(prepared.cleanup?.()).catch((error) => result.problems.push(`cleanup: ${error.message}`));
  }
  result.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  log(`${result.ok ? '✓' : '✗'} ${check.id} (${result.seconds}s)${result.ok ? '' : `: ${result.error}`}`);
  return result;
}

export async function runChecks({ only, viewport, log = console.log, start = startProductionFlujo }) {
  const plan = loadPlan(MAP_DIR, { only });
  const { checks, problems } = stepFileChecks(plan);
  const evidenceDir = path.join(EVIDENCE_DIR, EVIDENCE);
  if (!only) rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), viewport, problems: [...problems], results: [] };
  for (const problem of problems) log(`✗ ${problem}`);
  if (!checks.length && !problems.length) report.problems.push('No feature map bullet names a step file.');
  const opened = {};
  try {
    opened.stub = await startStubModel();
    opened.browser = await loadChromium();
    for (const [number, group] of instanceGroups(checks).entries()) {
      const env = Object.fromEntries(Object.entries(group.env).map(([key, value]) => [key, typeof value === 'function' ? value({ root: ROOT }) : value]));
      log(`\nFLUJO ${number + 1}${Object.keys(env).length ? ` with ${Object.keys(env).join(', ')}` : ''}: ${group.checks.length} check(s)`);
      const instance = await start({ logFile: path.join(evidenceDir, `flujo-${number + 1}.log`), log, env });
      try {
        for (const check of group.checks) {
          report.results.push(await runOne(opened.browser, check, {
            baseUrl: instance.baseUrl, dataDir: instance.dataDir, stub: opened.stub, viewport, log, root: ROOT,
          }));
        }
      } finally {
        await instance.stop();
      }
    }
  } catch (error) {
    report.problems.push(`The run stopped: ${String(error.message ?? error).split('\n')[0]}`);
    log(`✗ The run stopped: ${error.message}`);
  } finally {
    for (const close of [() => opened.browser?.close(), () => opened.stub?.close()]) {
      try { await close(); } catch (error) { report.problems.push(`cleanup: ${error.message}`); }
    }
  }
  const passed = report.problems.length === 0 && report.results.length === checks.length && report.results.every((result) => result.ok);
  writeFileSync(path.join(evidenceDir, only ? `report-${only.join('-')}.json` : 'report.json'),
    `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed }, null, 2)}\n`);
  log(`\n${passed ? 'Every feature map step file passed' : 'Some feature map step files failed'}: `
    + `${report.results.filter((result) => result.ok).length} of ${checks.length} passed. Report: ${evidenceDir}`);
  return passed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), log = console.log, { start } = {}) {
  const { options } = parseArgs(['run', ...argv]);
  if (options.help) {
    log(USAGE);
    return 0;
  }
  const only = typeof options.only === 'string' ? options.only.split(',').map((name) => name.trim()).filter(Boolean) : undefined;
  return runChecks({ only, viewport: parseViewport(options.viewport ?? '1600x900'), log, ...(start ? { start } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
