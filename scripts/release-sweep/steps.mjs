// Reads the "Driving it with flujo-drive" bullets of docs/feature-map/ and turns the ones written in
// the sweep grammar (docs/feature-map/README.md, "Steps the release sweep can run") into flujo-drive steps.
// A bullet the grammar does not cover is listed as manual, never guessed at.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DRIVING_SECTION = 'Driving it with flujo-drive';
export const DEFAULT_FILL = 'Release sweep check';

const DRIVE_COMMAND = /`node scripts\/flujo-drive\.mjs ([^`]+)`/;
const STEPS_MENTION = /`steps(?:\s+([^`\s]+))?(?:\s+--file\s+[^`]+)?`(?:\s+on\s+`([^`]+)`)?/;
const ROLES = new Map([
  ['button', 'button'], ['switch', 'switch'], ['radio', 'radio'], ['tab', 'tab'], ['link', 'link'], ['checkbox', 'checkbox'],
  ['menu item', 'menuitem'], ['menuitem', 'menuitem'], ['option', 'option'], ['combobox', 'combobox'],
]);
const ROLE_WORDS = [...ROLES.keys()].sort((left, right) => right.length - left.length).join('|');

/** Controls a sweep never presses, whatever a bullet says: they send data out, restart the app or lock it. */
export const UNSAFE_CONTROLS = [
  /^send$/i, /^update now$/i, /delete permanently/i, /turn on sign-in/i, /encryption password/i, /^public$/i, /^local network$/i,
];

/** Clicking a switch or checkbox in a written step means "make sure it is on", so walking several entries in a row never turns it off again. */
export function clickStep(role, name) {
  return role === 'switch' || role === 'checkbox' ? { do: 'check', role, name } : { do: 'click', role, name };
}

export function slug(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Splits on `separators` outside "double quotes" and `backticks`. */
function splitOutsideQuotes(text, separators) {
  const parts = [];
  let current = '';
  let quote;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
    } else if (char === '"' || char === '`') {
      quote = char;
      current += char;
    } else if (separators.includes(char)) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The text up to the first full stop that ends a sentence outside quotes. */
export function firstSentence(text) {
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === '`') quote = char;
    else if (char === '.' && (index === text.length - 1 || /\s/.test(text[index + 1]))) return text.slice(0, index);
  }
  return text;
}

function withoutParentheses(text) {
  let depth = 0;
  let quote;
  let result = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      if (!depth) result += char;
      continue;
    }
    if (char === '"' || char === '`') quote = char;
    if (char === '(') depth += 1;
    else if (char === ')' && depth) depth -= 1;
    else if (!depth) result += char;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/** Shell-like split of a flujo-drive command line ("double quotes" group words). */
export function tokenize(commandLine) {
  return [...commandLine.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
}

/** One step of a written steps list, or undefined when the grammar does not cover it. */
export function parseStepItem(item) {
  const text = item.trim().replace(/^(?:then|and)\s+/i, '').trim();
  if (!text) return { evidence: true };
  let match = new RegExp(`^click (${ROLE_WORDS}) "([^"]+)"$`, 'i').exec(text);
  if (match) return clickStep(ROLES.get(match[1].toLowerCase()), match[2]);
  match = /^fill (?:label )?"([^"]+)"(?: with (?:`([^`]*)`|"([^"]*)"|[^"`]+))?$/i.exec(text);
  if (match) return { do: 'fill', label: match[1], value: match[2] ?? match[3] ?? DEFAULT_FILL };
  match = /^`?expect-text`? "([^"]+)"$/i.exec(text);
  if (match) return { do: 'expect-text', text: match[1] };
  match = /^press `?([A-Za-z+]+)`?$/i.exec(text);
  if (match) return { do: 'press', key: match[1] };
  if (/^`?(?:shot|aria)`?(?: and `?(?:shot|aria)`?)?$/i.test(text)) return { evidence: true };
  return undefined;
}

/** A written list such as `click button "A", fill "B" with \`1\`; then aria`, or the reason it cannot run. */
export function parseStepList(text) {
  const items = splitOutsideQuotes(withoutParentheses(firstSentence(text)), [',', ';']);
  const steps = [];
  for (const item of items) {
    const step = parseStepItem(item);
    if (!step) return { reason: `the sweep grammar does not cover "${item.trim()}"` };
    if (!step.evidence) steps.push(step);
  }
  return steps.length ? { steps } : { reason: 'the steps list is empty' };
}

/** What the text right after → promises: `heading "X"`, `dialog "X"` or a leading "quoted text". */
export function parseOutcome(text = '') {
  const trimmed = text.trim();
  let match = /^(?:the )?heading "([^"]+)"/i.exec(trimmed);
  if (match) return { do: 'wait-for', role: 'heading', name: match[1] };
  match = /^(?:the |a )?dialog "([^"]+)"/i.exec(trimmed);
  if (match) return { do: 'wait-for', role: 'dialog', name: match[1] };
  match = /^"([^"]+)"/.exec(trimmed);
  if (match) return { do: 'expect-text', text: match[1] };
  return undefined;
}

function commandSteps(tokens) {
  const [command, ...rest] = tokens;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index].startsWith('--')) {
      const next = rest[index + 1];
      options[rest[index].slice(2)] = next !== undefined && !next.startsWith('--') ? rest[++index] : true;
    } else positional.push(rest[index]);
  }
  const route = positional[0] ?? '/';
  const viewport = typeof options.viewport === 'string' ? options.viewport : undefined;
  switch (command) {
    case 'open': case 'text': case 'aria': case 'shot':
      return { route, viewport, steps: [] };
    case 'click':
      return options.role && options.name ? { route, viewport, steps: [clickStep(options.role, options.name)] }
        : { reason: 'the click command lacks --role or --name' };
    case 'fill':
      return options.label ? { route, viewport, steps: [{ do: 'fill', label: options.label, value: typeof options.value === 'string' ? options.value : DEFAULT_FILL }] }
        : { reason: 'the fill command lacks --label' };
    case 'steps':
      return { route, viewport, listed: true };
    default:
      return { reason: `"${command}" is not a page command` };
  }
}

/** The text inside a "(...)" that opens `text`, with nested parentheses kept. */
function leadingParenthesis(text) {
  if (!text.startsWith('(')) return undefined;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return text.slice(1, index);
  }
  return undefined;
}

function placeholder(steps) {
  for (const step of steps) {
    for (const value of Object.values(step)) {
      const match = typeof value === 'string' ? /<[^>]+>/.exec(value) : null;
      if (match) return match[0];
    }
  }
  return undefined;
}

/**
 * Turns one driving bullet into a check.
 * status: auto (the sweep runs it), needs (a precondition a fresh instance lacks), manual (prose only), unsafe.
 */
export function parseBullet(entry, bullet, defaultRoute = '/') {
  const match = /^- \*\*(.+?)\*\*\s*(.*)$/s.exec(bullet.trim());
  if (!match) return undefined;
  const label = match[1].replace(/:$/, '').trim();
  let rest = match[2];
  const base = { id: `${entry}/${slug(label)}`, entry, label };
  const aside = leadingParenthesis(rest);
  if (aside) rest = rest.slice(aside.length + 2);
  if (aside && /^needs\b/i.test(aside.trim())) return { ...base, status: 'needs', reason: aside.trim() };
  rest = rest.replace(/^\s*:\s*/, '');
  const arrow = rest.indexOf('→');
  const action = arrow < 0 ? rest : rest.slice(0, arrow);
  const outcome = parseOutcome(arrow < 0 ? '' : rest.slice(arrow + 1));

  let route;
  let viewport;
  let steps;
  const command = DRIVE_COMMAND.exec(action);
  const mention = command ? undefined : STEPS_MENTION.exec(action);
  if (command) {
    const parsed = commandSteps(tokenize(command[1]));
    if (parsed.reason) return { ...base, status: 'manual', reason: parsed.reason };
    ({ route, viewport } = parsed);
    if (parsed.listed) {
      const listed = /The steps:\s*(.*)$/s.exec(action.slice(command.index + command[0].length));
      if (!listed) return { ...base, status: 'manual', reason: 'the steps command has no "The steps:" list' };
      const list = parseStepList(listed[1]);
      if (list.reason) return { ...base, status: 'manual', reason: list.reason };
      steps = list.steps;
    } else steps = parsed.steps;
  } else if (mention) {
    if (/\b(?:same|continue)\b/i.test(action.slice(0, mention.index))) {
      return { ...base, status: 'manual', reason: 'it continues another bullet\'s browser session' };
    }
    route = mention[2] ?? mention[1] ?? defaultRoute;
    const colon = action.indexOf(':', mention.index + mention[0].length);
    if (colon < 0) return { ...base, status: 'manual', reason: 'the steps list has no ":" before it' };
    const list = parseStepList(action.slice(colon + 1));
    if (list.reason) return { ...base, status: 'manual', reason: list.reason };
    steps = list.steps;
  } else {
    return { ...base, status: 'manual', reason: 'no flujo-drive command or `steps` list' };
  }

  const all = [{ do: 'goto', route }, ...steps, ...(outcome ? [outcome] : [])];
  const missing = placeholder(all);
  if (missing) return { ...base, status: 'needs', reason: `needs a real value for ${missing}`, steps: all };
  const unsafe = all.find((step) => (step.do === 'click' || step.do === 'check') && UNSAFE_CONTROLS.some((pattern) => pattern.test(step.name)));
  if (unsafe) return { ...base, status: 'unsafe', reason: `a sweep never presses "${unsafe.name}"`, steps: all };
  return { ...base, status: 'auto', steps: all, ...(viewport ? { viewport } : {}) };
}

/** The bullets of the driving section, with wrapped lines joined to their bullet. */
export function drivingBullets(content) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${DRIVING_SECTION}`);
  if (start < 0) return { preconditions: undefined, bullets: [] };
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    section.push(line);
  }
  const bullets = [];
  for (const line of section) {
    if (line.startsWith('- ')) bullets.push(line);
    else if (/^\s+\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  const preconditions = section.find((line) => line.startsWith('Preconditions:'))?.slice('Preconditions:'.length).trim();
  return { preconditions, bullets };
}

/** Every check in one feature map entry. The "Proof" bullet describes evidence and is not a check. */
export function parseEntryChecks(name, content) {
  const entry = name.replace(/\.md$/, '');
  const lines = content.split(/\r?\n/);
  const title = /^# \S/.test(lines[0] ?? '') ? lines[0].slice(2).trim() : entry;
  const routesLine = lines.find((line) => /^Routes:/.test(line)) ?? '';
  const routes = [...routesLine.matchAll(/`([^`]+)`/g)].map((found) => found[1]);
  const { preconditions, bullets } = drivingBullets(content);
  const checks = bullets
    .map((bullet) => parseBullet(entry, bullet, routes[0]))
    .filter((check) => check && check.label.toLowerCase() !== 'proof');
  return { entry, file: name, title, routes, preconditions, checks };
}

/** Entry file names in the order of the README's feature list, then any others alphabetically. */
export function sweepOrder(names, index) {
  const listed = [...index.matchAll(/\]\(\.?\/?([\w-]+\.md)\)/g)].map((match) => match[1]).filter((name) => names.includes(name));
  const ordered = [...new Set(listed)];
  return [...ordered, ...names.filter((name) => !ordered.includes(name)).sort()];
}

/** The whole sweep plan from a feature map folder. `only` limits it to some entries (file names without .md). */
export function loadPlan(mapDir, { only } = {}) {
  const names = readdirSync(mapDir).filter((name) => name.endsWith('.md') && name !== 'README.md');
  const order = sweepOrder(names, readFileSync(path.join(mapDir, 'README.md'), 'utf8'));
  const wanted = only?.length ? new Set(only.map((name) => name.replace(/\.md$/, ''))) : undefined;
  if (wanted) {
    const unknown = [...wanted].filter((name) => !names.includes(`${name}.md`));
    if (unknown.length) throw new Error(`No feature map entry named ${unknown.join(', ')} in ${mapDir}.`);
  }
  return order
    .filter((name) => !wanted || wanted.has(name.replace(/\.md$/, '')))
    .map((name) => parseEntryChecks(name, readFileSync(path.join(mapDir, name), 'utf8')));
}
