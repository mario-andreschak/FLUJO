#!/usr/bin/env node
// Keeps docs/feature-map/ in step with the pages in src/app (see .claude/skills/verify-flujo).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_DIR = 'docs/feature-map';
export const SECTIONS = ['Sub-features', 'How to get to it (user POV)', 'Driving it with flujo-drive', 'Gotchas'];

/** Turns `src/app/<dirs>/page.tsx` paths into routes, dropping route groups such as `(marketing)`. */
export function pageRoutes(pageFiles) {
  return pageFiles
    .map((file) => file.split(/[\\/]/).slice(0, -1).filter((segment) => !/^\(.*\)$/.test(segment)))
    .map((segments) => `/${segments.join('/')}`)
    .sort();
}

export function parseEntry(content) {
  const lines = content.split(/\r?\n/);
  const routesLine = lines.find((line) => /^Routes:/.test(line));
  return {
    title: /^# \S/.test(lines[0] ?? '') ? lines[0].slice(2).trim() : undefined,
    routes: routesLine ? [...new Set([...routesLine.matchAll(/`([^`]+)`/g)].map((match) => match[1].split('?')[0]))] : [],
    sections: lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim()),
  };
}

/**
 * @param {string[]} routes every page route in the app
 * @param {{ name: string, content: string }[]} entries feature map files other than README.md
 * @param {string} index the README.md content
 */
export function checkFeatureMap(routes, entries, index) {
  const problems = [];
  const owner = new Map();
  for (const { name, content } of entries) {
    const entry = parseEntry(content);
    const where = `${MAP_DIR}/${name}`;
    if (!entry.title) problems.push(`${where}: start with a "# Title" line.`);
    if (entry.routes.length === 0) problems.push(`${where}: add a "Routes:" line listing its pages in backticks.`);
    if (entry.sections.join('|') !== SECTIONS.join('|')) {
      problems.push(`${where}: use exactly these sections, in order: ${SECTIONS.map((section) => `"## ${section}"`).join(', ')}.`);
    }
    for (const route of entry.routes) {
      if (!routes.includes(route)) problems.push(`${where}: ${route} is not a page in src/app. Fix or remove it.`);
      else if (owner.has(route)) problems.push(`${where}: ${route} is already covered by ${owner.get(route)}.`);
      else owner.set(route, where);
    }
    if (!index.includes(`(${name})`) && !index.includes(`(./${name})`)) problems.push(`${MAP_DIR}/README.md: link ${name} in the feature list.`);
  }
  for (const route of routes) {
    if (!owner.has(route)) problems.push(`${route} has no feature map entry. Add it to a file in ${MAP_DIR}/ (see the skill verify-flujo).`);
  }
  return problems;
}

export function findPages(directory, prefix = '') {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && entry.name !== 'api' && !entry.name.startsWith('_')) found.push(...findPages(path.join(directory, entry.name), relative));
    else if (entry.isFile() && /^page\.(?:tsx|jsx|ts|js)$/.test(entry.name)) found.push(relative);
  }
  return found;
}

export function run({ cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  const routes = pageRoutes(findPages(path.join(cwd, 'src/app')));
  const mapDir = path.join(cwd, MAP_DIR);
  const names = readdirSync(mapDir).filter((name) => name.endsWith('.md') && name !== 'README.md').sort();
  const entries = names.map((name) => ({ name, content: readFileSync(path.join(mapDir, name), 'utf8') }));
  const problems = checkFeatureMap(routes, entries, readFileSync(path.join(mapDir, 'README.md'), 'utf8'));
  if (problems.length) {
    error(['The feature map is out of step with the app:', ...problems.map((problem) => `  ${problem}`)].join('\n'));
    return 1;
  }
  log(`Feature map covers all ${routes.length} pages in ${entries.length} entries.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
