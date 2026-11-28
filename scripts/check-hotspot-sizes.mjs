#!/usr/bin/env node
// runFlow.ts, ModelHandler.ts and the MCP service index.ts grew with every
// feature (#571). Each has a line ceiling in scripts/execution-hotspots.json,
// and the ceiling only goes down. This check fails when a file grows past its
// ceiling, when a file shrank but its ceiling was not lowered, when a branch
// raises a ceiling, when a module split out of one of them is not named in
// the architecture guide, and when the guide names a file that does not exist.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_FILE = 'scripts/execution-hotspots.json';
export const GUIDE = 'docs/architecture/execution-module-boundaries.md';

/** Counts lines the way `wc -l` does for a file that ends with a newline. */
export function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** Lists files above their ceiling ("grew") and ceilings above their file ("stale"). */
export function findSizeProblems(hotspots, linesOf) {
  const problems = [];
  for (const { file, maxLines } of hotspots) {
    const lines = linesOf(file);
    if (lines > maxLines) problems.push({ file, kind: 'grew', lines, maxLines });
    else if (lines < maxLines) problems.push({ file, kind: 'stale', lines, maxLines });
  }
  return problems;
}

/** Lists ceilings that are higher than on the base, and hotspots the branch removed. */
export function findRaisedCeilings(base, current) {
  const now = new Map(current.map(({ file, maxLines }) => [file, maxLines]));
  const raised = [];
  for (const { file, maxLines } of base) {
    const after = now.get(file);
    if (after === undefined || after > maxLines) raised.push({ file, before: maxLines, after });
  }
  return raised;
}

/** Lists split modules the guide does not name, by file name in backticks. */
export function findUndocumentedModules(hotspots, guideText) {
  const missing = [];
  for (const { modules = [] } of hotspots) {
    for (const split of modules) {
      if (!guideText.includes(`\`${path.posix.basename(split)}\``)) missing.push(split);
    }
  }
  return missing;
}

/** File names the guide writes in backticks outside code blocks: `runFlow.ts`, `src/a/b.ts`, `flow/x.test.ts`. */
export function guideFileNames(guideText) {
  const prose = guideText.replace(/```[\s\S]*?```/g, '');
  const names = new Set();
  for (const [, token] of prose.matchAll(/`([^`\s]+)`/g)) {
    if (/^[\w@[\]-][\w@.[\]/-]*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md)$/.test(token)) names.add(token);
  }
  return [...names];
}

/**
 * Where a short name in the guide may live: the repository root, `__tests__/`,
 * every folder the guide writes in backticks, and the folders of the big files
 * and their split modules.
 */
export function guideFolders(hotspots, guideText) {
  const folders = new Set(['', '__tests__/']);
  for (const [, folder] of guideText.matchAll(/`([\w.[\]/-]+\/)`/g)) folders.add(folder);
  for (const { file, modules = [] } of hotspots) {
    for (const named of [file, ...modules]) folders.add(`${path.posix.dirname(named)}/`);
  }
  return [...folders];
}

/** Lists file names in the guide that exist in none of its folders. */
export function findMissingGuideFiles(hotspots, guideText, exists) {
  const folders = guideFolders(hotspots, guideText);
  return guideFileNames(guideText).filter((name) => !folders.some((folder) => exists(`${folder}${name}`)));
}

/** Lowers every stale ceiling to the file's current length. Never raises one. */
export function lowerCeilings(contract, linesOf) {
  return {
    ...contract,
    hotspots: contract.hotspots.map((hotspot) => ({
      ...hotspot,
      maxLines: Math.min(hotspot.maxLines, linesOf(hotspot.file)),
    })),
  };
}

export function describeProblems(problems, raised, undocumented = [], missingFiles = []) {
  const out = [];
  const grew = problems.filter((problem) => problem.kind === 'grew');
  const stale = problems.filter((problem) => problem.kind === 'stale');
  if (grew.length) {
    out.push('These files grew past their line ceiling:');
    for (const { file, lines, maxLines } of grew) out.push(`  ${file}  ${maxLines} -> ${lines}`);
    out.push(`Move the new code into a module with one clear job (see ${GUIDE}) and import it.`);
    out.push('If the file must still call it, move a nearby block of the same kind out with it ("Adding to a big file" in the guide).');
    out.push('Do not raise the ceiling.');
  }
  if (stale.length) {
    out.push('These files shrank. Lower their ceiling so they cannot grow back:');
    for (const { file, lines, maxLines } of stale) out.push(`  ${file}  ${maxLines} -> ${lines}`);
    out.push('Run: npm run check:hotspots -- --write');
  }
  if (raised.length) {
    out.push(`${CONTRACT_FILE} may only lower ceilings, but this branch raised or removed one:`);
    for (const { file, before, after } of raised) out.push(`  ${file}  ${before} -> ${after ?? 'removed'}`);
    out.push('Keep the ceiling and move code out of the file instead.');
  }
  if (undocumented.length) {
    out.push(`These split modules are not named in ${GUIDE}:`);
    for (const file of undocumented) out.push(`  ${file}`);
    out.push('Add each one to the module map there: what it owns and the contract it keeps.');
  }
  if (missingFiles.length) {
    out.push(`${GUIDE} names files that do not exist:`);
    for (const name of missingFiles) out.push(`  ${name}`);
    out.push('Write each as its path from the repository root, or as its name inside a folder the guide names in backticks.');
    out.push('If the file moved or was removed, point the guide at the code that owns the behaviour now.');
  }
  return out.join('\n');
}

/** The guide's text. A missing guide names nothing. */
function readGuide(cwd) {
  try {
    return readFileSync(path.join(cwd, GUIDE), 'utf8');
  } catch {
    return '';
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
}

function resolveBase(cwd, env) {
  if (env.HOTSPOT_BASE) return env.HOTSPOT_BASE;
  // CI checks out the PR merge commit or the pushed main commit: its first parent is the base.
  if (env.GITHUB_ACTIONS === 'true') return git(['rev-parse', 'HEAD^1'], cwd).trim();
  return git(['merge-base', 'HEAD', 'origin/main'], cwd).trim();
}

export function run({ cwd = process.cwd(), env = process.env, argv = process.argv.slice(2), log = console.log, error = console.error } = {}) {
  const contractPath = path.join(cwd, CONTRACT_FILE);
  let contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  const linesOf = (file) => countLines(readFileSync(path.join(cwd, file), 'utf8'));
  if (argv.includes('--write')) {
    contract = lowerCeilings(contract, linesOf);
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  }

  let raised = [];
  let baseNote = 'no base commit to compare with';
  try {
    const base = resolveBase(cwd, env);
    try {
      raised = findRaisedCeilings(JSON.parse(git(['show', `${base}:${CONTRACT_FILE}`], cwd)).hotspots, contract.hotspots);
      baseNote = `compared with ${base.slice(0, 12)}`;
    } catch {
      baseNote = 'the base has no ceilings yet';
    }
  } catch (cause) {
    if (env.GITHUB_ACTIONS === 'true') {
      error(`Cannot find the base commit to compare ${CONTRACT_FILE} with. Check out at least two commits (fetch-depth: 2).\n${cause.message}`);
      return 1;
    }
  }

  const problems = findSizeProblems(contract.hotspots, linesOf);
  const guideText = readGuide(cwd);
  const undocumented = findUndocumentedModules(contract.hotspots, guideText);
  const missingFiles = findMissingGuideFiles(contract.hotspots, guideText, (file) => existsSync(path.join(cwd, file)));
  if (problems.length || raised.length || undocumented.length || missingFiles.length) {
    error(describeProblems(problems, raised, undocumented, missingFiles));
    return 1;
  }
  log(`Hotspot sizes hold (${baseNote}): ${contract.hotspots.map(({ file, maxLines }) => `${path.basename(file)} ${maxLines}`).join(', ')}; every split module is in the guide and every file it names exists.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
