#!/usr/bin/env node
// "Corrections become checks" (AGENTS.md): every rule is one small file in docs/corrections/, so
// parallel branches never edit the same lines. This check fails when a rule names a lint rule, file,
// test or script that does not exist, or a check that CI never runs. Recipe: .claude/skills/correct.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const CORRECTIONS_DIR = 'docs/corrections';
export const AGENTS_FILE = 'AGENTS.md';
const SECTION_HEADING = '# Corrections become checks';
const LABELS = ['Enforced by', 'Verified by', 'Prose'];
const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const JEST_TEST = /^__tests__\/.+\.test\.tsx?$/;
const ANY_TEST = /\.test\.[cm]?[jt]sx?$/;
const FILE_LIKE = /^[^\s/][^\s]*\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const LINT_RULE = /^(?:@[\w-]+\/)?[\w-]+\/(?:[\w-]+|\*)$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\(\))?$/;
const FIX_ADOPT = `Run \`node scripts/check-corrections.mjs --adopt\` to move them into ${CORRECTIONS_DIR}/.`;

export const FORMAT = `Each file in ${CORRECTIONS_DIR}/ holds one rule:

  # <the rule in one sentence>

  <optional: why, with an example of the mistake>

  Enforced by:
  - \`<lint rule, test file or npm run script that CI runs>\`
  - \`<symbol>\` in \`<path/from/the/repository/root>\`

"Verified by:" lists checks run by hand (verify-flujo, a journey).
"Prose: <why it needs judgment>" is for rules no program can check.`;

/** Backticked tokens in a piece of Markdown. */
export function tokens(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

/** Splits `text` on `separator`, ignoring separators inside backticks. */
export function splitOutsideCode(text, separator) {
  const parts = [];
  let current = '';
  let inCode = false;
  for (const char of text) {
    if (char === '`') inCode = !inCode;
    if (char === separator && !inCode) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseCorrection(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const title = /^# \S/.test(lines[0] ?? '') ? lines[0].slice(2).trim() : undefined;
  const parts = Object.fromEntries(LABELS.map((label) => [label, []]));
  const body = [];
  let current;
  for (const line of lines.slice(1)) {
    const label = new RegExp(`^(${LABELS.join('|')}):\\s*(.*)$`).exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (label) {
      current = label[1];
      if (label[2].trim()) parts[current].push(label[2].trim());
    } else if (current && current !== 'Prose' && bullet) {
      parts[current].push(bullet[1].trim());
    } else if (line.trim()) {
      current = undefined;
      body.push(line);
    }
  }
  return {
    title,
    body: body.join('\n'),
    enforcedBy: parts['Enforced by'],
    verifiedBy: parts['Verified by'],
    prose: parts.Prose.join(' '),
  };
}

/** What a backticked token in an "Enforced by" or "Verified by" line points at. */
export function classify(token, exists) {
  const script = /^npm run ([\w:.-]+)/.exec(token);
  if (script) return { kind: 'script', name: script[1] };
  if (FILE_LIKE.test(token) || exists(token)) return { kind: 'file', path: token.replace(/\/$/, '') };
  if (LINT_RULE.test(token)) return { kind: 'lint', rule: token };
  if (IDENTIFIER.test(token)) return { kind: 'symbol', name: token.replace(/\(\)$/, '') };
  return { kind: 'text' };
}

/**
 * Finds the commands that run on every pull request: the `run:` steps of workflows triggered by
 * `pull_request`, plus the package scripts those steps call (followed through `npm run`).
 * @param {{ name: string, content: string }[]} workflows
 * @param {Record<string, string>} scripts package.json scripts
 */
export function ciCommands(workflows, scripts) {
  const runs = [];
  for (const { content } of workflows) {
    const workflow = YAML.parse(content) ?? {};
    const on = workflow.on ?? {};
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
    if (!triggers.includes('pull_request')) continue;
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job?.steps ?? []) if (typeof step?.run === 'string') runs.push(step.run);
    }
  }
  const called = new Set();
  const queue = [...runs];
  while (queue.length) {
    for (const match of queue.pop().matchAll(/\bnpm (?:run ([\w:.-]+)|(test)\b)/g)) {
      const name = match[1] ?? match[2];
      if (scripts[name] !== undefined && !called.has(name)) {
        called.add(name);
        queue.push(scripts[name]);
      }
    }
  }
  return { text: [...runs, ...[...called].map((name) => scripts[name])].join('\n'), scripts: called };
}

/** Whether a CI command runs `file`: it follows `node`, a shell or `./` on its line, not just a mention in code. */
export function runsFile(text, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-])`, 'g');
  return text.split('\n').some((line) => [...line.matchAll(pattern)].some((match) => {
    const before = line.slice(0, match.index);
    return /(?:^|[\s;&|(])(?:node|npx|bash|sh|pwsh|powershell)\b/.test(before) || before.endsWith('./');
  }));
}

/**
 * Facts about a checkout that the check needs. Tests pass a fake with the same shape.
 * @returns {{ exists(file: string): boolean, read(file: string): string, files: string[], topLevel: Set<string>,
 *   scripts: Record<string, string>, ci: { text: string, scripts: Set<string> }, eslintConfig: string, flujoRules: Set<string> }}
 */
export function repoFacts(cwd) {
  const read = (file) => readFileSync(path.join(cwd, file), 'utf8');
  const { scripts = {} } = JSON.parse(read('package.json'));
  const workflowDir = '.github/workflows';
  const workflows = readdirSync(path.join(cwd, workflowDir))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, content: read(`${workflowDir}/${name}`) }));
  const plugin = read('tooling/eslint-plugin-flujo/index.mjs');
  const rulesBlock = /rules:\s*\{([\s\S]*?)\}/.exec(plugin)?.[1] ?? '';
  return {
    exists: (file) => existsSync(path.join(cwd, file)),
    read,
    topLevel: new Set(readdirSync(cwd, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)),
    scripts,
    ci: ciCommands(workflows, scripts),
    eslintConfig: read('eslint.config.mjs'),
    flujoRules: new Set([...rulesBlock.matchAll(/'([\w-]+)':/g)].map((match) => match[1])),
  };
}

export function runsInCi(file, repo) {
  if (JEST_TEST.test(file) && !file.startsWith('__tests__/enduringAgents/') && repo.ci.scripts.has('test:ci')) return true;
  return runsFile(repo.ci.text, file);
}

function howToRunInCi(file) {
  if (JEST_TEST.test(file)) return 'Pull request CI skips __tests__/enduringAgents/; list it under "Verified by" or name a test that runs.';
  return 'Add it to the "test:checks" script in package.json so the lint job runs it, or list it under "Verified by".';
}

export function lintRuleOn(rule, repo) {
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '[\\w-]+');
  const on = new RegExp(`['"]${escaped}['"]\\s*:\\s*(?:\\[\\s*)?['"]error['"]`).test(repo.eslintConfig);
  if (rule.startsWith('flujo/')) return on && repo.flujoRules.has(rule.slice('flujo/'.length));
  return on;
}

function checkLine(line, files, repo, say, needsCi) {
  const refs = tokens(line).map((token) => classify(token, repo.exists));
  if (refs.every((ref) => ref.kind === 'text')) {
    say(`"${line}" names no check. Put the lint rule, file path or \`npm run\` script in backticks.`);
    return false;
  }
  let runs = false;
  for (const ref of refs) {
    if (ref.kind === 'file') {
      if (!repo.exists(ref.path)) {
        const hint = ref.path.includes('/') ? 'Fix the path, or drop it if the check is gone.' : 'Write the path from the repository root.';
        say(`\`${ref.path}\` does not exist. ${hint}`);
      } else if (runsInCi(ref.path, repo)) {
        runs = true;
      } else if (needsCi && ANY_TEST.test(ref.path)) {
        say(`\`${ref.path}\` is not run by CI. ${howToRunInCi(ref.path)}`);
      }
    } else if (ref.kind === 'lint') {
      if (lintRuleOn(ref.rule, repo)) runs ||= repo.ci.scripts.has('lint:all');
      else say(`lint rule \`${ref.rule}\` is not switched on ("error") in eslint.config.mjs${ref.rule.startsWith('flujo/') ? ' or is missing from tooling/eslint-plugin-flujo/index.mjs' : ''}.`);
    } else if (ref.kind === 'script') {
      if (repo.scripts[ref.name] === undefined) say(`\`npm run ${ref.name}\` is not a script in package.json.`);
      else if (repo.ci.scripts.has(ref.name)) runs = true;
    } else if (ref.kind === 'symbol') {
      if (!files.length) say(`say which file \`${ref.name}\` is in, as a path from the repository root.`);
      else if (!files.some((file) => repo.read(file).includes(ref.name))) {
        say(`\`${ref.name}\` is not in ${files.map((file) => `\`${file}\``).join(' or ')}. Fix the name or the file.`);
      }
    }
  }
  return runs;
}

/**
 * @param {{ name: string, content: string }[]} entries the files in docs/corrections/ other than README.md
 * @param {ReturnType<typeof repoFacts>} repo
 */
export function checkCorrections(entries, repo) {
  const problems = [];
  const titles = new Map();
  for (const { name, content } of entries) {
    const where = `${CORRECTIONS_DIR}/${name}`;
    const say = (text) => problems.push(`${where}: ${text}`);
    if (!FILE_NAME.test(name)) say('name the file in lower-case words joined by "-", ending in .md.');
    const entry = parseCorrection(content);
    if (!entry.title) {
      say('start with a "# <the rule in one sentence>" line.');
      continue;
    }
    if (titles.has(entry.title)) say(`states the same rule as ${titles.get(entry.title)}. Merge the two files.`);
    else titles.set(entry.title, where);
    if (!entry.enforcedBy.length && !entry.verifiedBy.length && !entry.prose) {
      say('add "Enforced by:" with the check CI runs, "Verified by:" with a check run by hand, or "Prose: <why it needs judgment>".');
      continue;
    }
    const refs = [entry.title, entry.body, ...entry.enforcedBy, ...entry.verifiedBy].flatMap(tokens);
    const files = refs.filter((token) => FILE_LIKE.test(token) && repo.exists(token));
    for (const token of tokens(`${entry.title}\n${entry.body}`)) {
      const isRepoPath = FILE_LIKE.test(token) && token.includes('/') && repo.topLevel.has(token.split('/')[0]);
      if (isRepoPath && !repo.exists(token)) say(`\`${token}\` does not exist. Fix the path in the rule.`);
    }
    const enforced = entry.enforcedBy.map((line) => checkLine(line, files, repo, say, true));
    for (const line of entry.verifiedBy) checkLine(line, files, repo, say, false);
    if (enforced.length && !enforced.includes(true)) {
      say('nothing under "Enforced by" runs in CI. Name the lint rule, test or `npm run` script that fails for this mistake, or list it under "Verified by".');
    }
  }
  return problems;
}

/** The "Corrections become checks" section of AGENTS.md, as line indexes [start, end). */
function sectionRange(lines) {
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) return undefined;
  const next = lines.findIndex((line, index) => index > start && /^# \S/.test(line));
  return [start, next === -1 ? lines.length : next];
}

/** Table rows (`| rule | check |`) still written into AGENTS.md, without the header and separator. */
export function agentsTableRows(agentsText) {
  const lines = agentsText.replace(/\r\n?/g, '\n').split('\n');
  const range = sectionRange(lines);
  if (!range) return [];
  return lines.slice(...range)
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => splitOutsideCode(line.trim().replace(/^\|/, '').replace(/\|$/, ''), '|'))
    .filter((cells) => cells.length >= 2 && !/^:?-+:?$/.test(cells[0]) && !(cells[0] === 'Rule' && cells[1] === 'Enforced by'));
}

export function checkAgents(agentsText) {
  const lines = agentsText.replace(/\r\n?/g, '\n').split('\n');
  if (!sectionRange(lines)) return [`${AGENTS_FILE}: keep the "${SECTION_HEADING}" section; it points agents at ${CORRECTIONS_DIR}/.`];
  const rows = agentsTableRows(agentsText);
  if (!rows.length) return [];
  return [`${AGENTS_FILE}: ${rows.length} rule row(s) are written into the table instead of ${CORRECTIONS_DIR}/ `
    + `(first: "${rows[0][0].slice(0, 60)}"). ${FIX_ADOPT}`];
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'with']);

export function slugFor(rule, taken) {
  const words = rule.replace(/[`']/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (SMALL_WORDS.has(words[0])) words.shift();
  const picked = [];
  for (const word of words) {
    if (picked.length && [...picked, word].join('-').length > 45) break;
    picked.push(word);
  }
  while (picked.length > 1 && SMALL_WORDS.has(picked.at(-1))) picked.pop();
  const base = picked.join('-') || 'rule';
  let name = `${base}.md`;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}.md`;
  taken.add(name);
  return name;
}

export function correctionFile(rule, check) {
  if (/^prose\b/i.test(check)) return `# ${rule}\n\nProse: ${check.replace(/^prose:?\s*/i, '')}\n`;
  return `# ${rule}\n\nEnforced by:\n${splitOutsideCode(check, ';').map((part) => `- ${part}`).join('\n')}\n`;
}

const wordsOf = (text) => new Set(text.replace(/`/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** The existing rule file whose title shares most words with `rule` (a row changed on another branch), if any. */
export function similarRule(rule, entries) {
  const words = wordsOf(rule);
  let best;
  for (const { name, content } of entries) {
    const other = wordsOf(parseCorrection(content).title ?? '');
    if (!other.size || !words.size) continue;
    const score = [...words].filter((word) => other.has(word)).length / Math.min(words.size, other.size);
    if (score >= 0.8 && (!best || score > best.score)) best = { name, score };
  }
  return best?.name;
}

/**
 * Moves table rows found in AGENTS.md (left there by a branch from before the split) into their own
 * files and removes the table. A row that an existing file already covers (same or fewer words in the
 * rule, every check it names) is dropped. A row that looks like a changed copy of an existing rule is
 * copied and reported, so the person merging keeps one.
 * @param {{ name: string, content: string }[]} existing the rule files already in docs/corrections/
 */
export function adoptAgentsTable(agentsText, existing) {
  const taken = new Set(existing.map(({ name }) => name));
  const files = [];
  const notes = [];
  for (const [rule, check] of agentsTableRows(agentsText)) {
    const exact = existing.find(({ content }) => parseCorrection(content).title === rule);
    const similar = exact ?? existing.find(({ name }) => name === similarRule(rule, existing));
    const coversChecks = (entry) => tokens(check).every((token) => entry.content.includes(token));
    const coversRule = (entry) => [...wordsOf(rule)].every((word) => wordsOf(parseCorrection(entry.content).title ?? '').has(word));
    if (similar && coversChecks(similar) && coversRule(similar)) continue;
    if (exact) {
      notes.push(`${exact.name} already holds this rule, but its row also named: ${check}`);
      continue;
    }
    const name = slugFor(rule, taken);
    if (similar) notes.push(`${name} looks like a changed copy of ${similar.name}; keep one of the two.`);
    files.push({ name, content: correctionFile(rule, check) });
  }
  const lines = agentsText.replace(/\r\n?/g, '\n').split('\n');
  const range = sectionRange(lines);
  if (!range) return { agents: agentsText, files, notes };
  const kept = lines.filter((line, index) => index < range[0] || index >= range[1] || !line.trimStart().startsWith('|'));
  return { agents: kept.join('\n').replace(/\n{3,}/g, '\n\n'), files, notes };
}

export function listTable(entries) {
  const cell = (text) => text.replace(/\|/g, '\\|');
  return [
    '| Rule | Enforced by | File |',
    '|---|---|---|',
    ...entries.map(({ name, content }) => {
      const entry = parseCorrection(content);
      const how = entry.enforcedBy.length ? entry.enforcedBy.join('; ')
        : entry.verifiedBy.length ? `By hand: ${entry.verifiedBy.join('; ')}` : `Prose: ${entry.prose}`;
      return `| ${cell(entry.title ?? '?')} | ${cell(how)} | ${name} |`;
    }),
  ].join('\n');
}

function readEntries(cwd) {
  const dir = path.join(cwd, CORRECTIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map((name) => ({ name, content: readFileSync(path.join(dir, name), 'utf8') }));
}

export function run({ cwd = process.cwd(), argv = process.argv.slice(2), log = console.log, error = console.error } = {}) {
  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (argv.includes('--adopt')) {
    const agentsText = readFileSync(agentsPath, 'utf8');
    const { agents, files, notes } = adoptAgentsTable(agentsText, readEntries(cwd));
    mkdirSync(path.join(cwd, CORRECTIONS_DIR), { recursive: true });
    for (const { name, content } of files) writeFileSync(path.join(cwd, CORRECTIONS_DIR, name), content);
    if (agents !== agentsText) writeFileSync(agentsPath, agents);
    log(files.length ? `Moved ${files.length} row(s) from ${AGENTS_FILE} into ${CORRECTIONS_DIR}/:\n${files.map(({ name }) => `  ${name}`).join('\n')}`
      : `No new rules in the ${AGENTS_FILE} table.`);
    if (notes.length) log(`Check these by hand:\n${notes.map((note) => `  ${note}`).join('\n')}`);
  }
  const entries = readEntries(cwd);
  if (argv.includes('--list')) log(listTable(entries));
  const problems = [...checkAgents(readFileSync(agentsPath, 'utf8')), ...checkCorrections(entries, repoFacts(cwd))];
  if (problems.length) {
    error(['"Corrections become checks" is out of step with the repository:', ...problems.map((problem) => `  ${problem}`), '', FORMAT].join('\n'));
    return 1;
  }
  log(`All ${entries.length} rules in ${CORRECTIONS_DIR}/ name checks that exist, and each enforced rule has one CI runs.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run();
}
