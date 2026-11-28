import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #1226: tool results reach models in seven places (FLUJO's tool loop, a
 * call a person approved, the Claude, Codex and Antigravity adapters, the
 * native broker and history reload). Before the setting existed, two of them
 * sized results from the raw stored numbers and ignored the on/off switch, so
 * they disagreed with the rest. Server code must decide sizes only through
 * `resolveToolResultBound` (src/shared/toolResultLimit.ts), never by reading
 * the stored limit fields, and every place must hand it the AI step's own
 * limit, so an agent's choice holds on every path.
 */
const SERVER_ROOT = path.join(process.cwd(), 'src', 'backend');
const RAW_LIMIT_READ = /\.(toolResultMaxBytes|toolResultMaxLines|toolResultTruncationEnabled)\b/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The text of every call to `name(...)` in `source`, from its name to its closing parenthesis. */
function callsOf(source: string, name: string): Array<{ line: number; text: string }> {
  const calls: Array<{ line: number; text: string }> = [];
  const pattern = new RegExp(`\\b${name}\\(`, 'g');
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      if (source[end] === ')' && --depth === 0) break;
    }
    const text = source.slice(match.index, end + 1);
    const definition = /\bfunction\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index));
    if (!definition) calls.push({ line: source.slice(0, match.index).split('\n').length, text });
  }
  return calls;
}

describe('one rule for the tool result size limit', () => {
  const files = sourceFiles(SERVER_ROOT).map((file) => ({
    name: path.relative(process.cwd(), file),
    source: fs.readFileSync(file, 'utf8'),
  }));

  it('server code never reads the stored limit fields directly', () => {
    const offenders = files.flatMap(({ name, source }) => source
      .split(/\r?\n/)
      .flatMap((line, index) => (RAW_LIMIT_READ.test(line) ? [`${name}:${index + 1}: ${line.trim()}`] : [])));
    if (offenders.length > 0) {
      throw new Error('Use resolveToolResultBound (src/shared/toolResultLimit.ts) instead of reading the '
        + `tool result limit fields:\n${offenders.join('\n')}`);
    }
  });

  it('every place that sizes a tool result hands over the AI step\'s own limit', () => {
    const offenders = files.flatMap(({ name, source }) => [
      ...callsOf(source, 'boundToolResult').filter((call) => !/\blimit\b/.test(call.text)),
      ...callsOf(source, 'resolveToolResultBound').filter((call) => call.text.split(',').length < 3),
    ].map((call) => `${name}:${call.line}`));
    if (offenders.length > 0) {
      throw new Error('Pass the step\'s limit (`limit: toolResults?.limit` to boundToolResult, or the third argument '
        + 'of resolveToolResultBound) so the agent\'s own choice applies here too; the step limit reaches tool calls as '
        + `\`toolResults\` (see src/backend/execution/flow/stepToolResults.ts):\n${offenders.join('\n')}`);
    }
  });
});
