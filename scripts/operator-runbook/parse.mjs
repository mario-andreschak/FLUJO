// Read the operator runbook (docs/operations/operator-runbook.md) into steps.
// A step starts at `<!-- operator-step: <id> -->` and holds one bash and one
// PowerShell block, up to the next step or heading. Every problem is reported
// at once, so a broken page lists everything that needs fixing.

/** The steps an operator needs, in the order the page must give them. */
export const REQUIRED_STEPS = Object.freeze(['choose', 'start', 'check', 'diagnose', 'back-up', 'stop', 'upgrade', 'restore']);
/** Steps a person does by hand; the run does them itself and the page holds no command for them. */
export const ACTION_STEPS = Object.freeze(['stop']);
/** Steps that keep running until the operator stops them. */
export const BACKGROUND_STEPS = Object.freeze(['start', 'upgrade']);
/** What the choose step sets; the run supplies its own values for exactly these. */
export const OPERATOR_VARIABLES = Object.freeze(['FLUJO_VERSION', 'FLUJO_NEW_VERSION', 'FLUJO_DATA_DIR', 'FLUJO_PORT', 'FLUJO_BACKUP']);
export const SHELLS = Object.freeze({ bash: 'bash', powershell: 'powershell' });

const MARKER = /^<!--\s*operator-step:\s*([a-z-]+)\s*-->\s*$/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^```(\S*)/;

/** Steps in page order: `{ id, line, blocks: { bash?, powershell? } }`. */
export function readSteps(markdown) {
  const steps = []; let step = null; let fence = null;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (fence) {
      if (line.startsWith('```')) {
        if (step && Object.hasOwn(SHELLS, fence.language)) {
          if (step.blocks[fence.language] !== undefined) step.duplicateBlocks.push(fence.language);
          else step.blocks[fence.language] = fence.lines.join('\n');
        }
        fence = null;
      } else fence.lines.push(line);
      return;
    }
    const marker = MARKER.exec(line);
    if (marker) {
      step = { id: marker[1], line: index + 1, blocks: {}, duplicateBlocks: [] };
      steps.push(step);
      return;
    }
    if (HEADING.test(line)) { step = null; return; }
    const opened = FENCE.exec(line);
    if (opened) fence = { language: opened[1].toLowerCase(), lines: [] };
  });
  return steps;
}

/** Variables a block assigns: `export NAME=` in bash, `$env:NAME =` in PowerShell. */
export function assignedVariables(shell, script) {
  const pattern = shell === 'bash' ? /^\s*export\s+([A-Z][A-Z0-9_]*)=/gm : /^\s*\$env:([A-Z][A-Z0-9_]*)\s*=/gm;
  return [...script.matchAll(pattern)].map(match => match[1]);
}

/** FLUJO variables a block reads. */
export function referencedVariables(shell, script) {
  const pattern = shell === 'bash' ? /\$\{?(FLUJO_[A-Z0-9_]+)/g : /\$env:(FLUJO_[A-Z0-9_]+)/g;
  return [...new Set([...script.matchAll(pattern)].map(match => match[1]))];
}

const sameSet = (left, right) => left.length === right.length && [...left].sort().join() === [...right].sort().join();

/**
 * Check the page and return its steps by id. The page must serve both
 * shells, whatever system reads it, so a missing Windows command fails on
 * Linux too.
 */
export function parseRunbook(markdown) {
  const steps = readSteps(markdown);
  const problems = [];
  const byId = new Map();
  for (const step of steps) {
    if (!REQUIRED_STEPS.includes(step.id)) problems.push(`Line ${step.line}: "${step.id}" is not an operator step (expected one of ${REQUIRED_STEPS.join(', ')}).`);
    else if (byId.has(step.id)) problems.push(`Line ${step.line}: the "${step.id}" step appears twice.`);
    else byId.set(step.id, step);
    for (const shell of step.duplicateBlocks) problems.push(`Line ${step.line}: the "${step.id}" step has more than one ${shell} block.`);
  }
  for (const id of REQUIRED_STEPS.filter(item => !byId.has(item))) problems.push(`The runbook has no "${id}" step.`);
  const order = steps.map(step => step.id).filter(id => REQUIRED_STEPS.includes(id));
  const expected = REQUIRED_STEPS.filter(id => order.includes(id));
  if ([...new Set(order)].join() !== expected.join()) problems.push(`The steps must come in this order: ${REQUIRED_STEPS.join(', ')}.`);
  for (const [id, step] of byId) {
    for (const shell of Object.keys(SHELLS)) {
      const script = step.blocks[shell];
      if (ACTION_STEPS.includes(id)) {
        if (script !== undefined) problems.push(`The "${id}" step is done by hand; it must not hold a ${shell} command.`);
        continue;
      }
      if (script === undefined || !script.trim()) { problems.push(`The "${id}" step has no ${shell} command.`); continue; }
      if (shell === 'powershell' && /(^|\s)-Form\b/i.test(script)) {
        problems.push(`The powershell "${id}" step uploads with -Form, whose unquoted multipart headers FLUJO refuses; upload with curl.exe -F instead.`);
      }
      if (id === 'choose') {
        const assigned = assignedVariables(shell, script);
        if (!sameSet(assigned, OPERATOR_VARIABLES)) {
          problems.push(`The ${shell} "choose" step sets ${assigned.join(', ') || 'nothing'}; it must set exactly ${OPERATOR_VARIABLES.join(', ')}.`);
        }
      } else {
        for (const name of referencedVariables(shell, script).filter(item => !OPERATOR_VARIABLES.includes(item))) {
          problems.push(`The ${shell} "${id}" step uses ${name}, which the "choose" step never sets.`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`The operator runbook is incomplete or wrong:\n- ${problems.join('\n- ')}`);
  return Object.fromEntries(byId);
}
