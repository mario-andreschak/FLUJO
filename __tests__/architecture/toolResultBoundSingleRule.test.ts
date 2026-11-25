import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #1226: tool results reach models in six places (FLUJO's tool loop, the
 * Claude, Codex and Antigravity adapters, the native broker and history
 * reload). Before the setting existed, two of them sized results from the raw
 * stored numbers and ignored the on/off switch, so they disagreed with the
 * rest. Server code must decide sizes only through `resolveToolResultBound`
 * (src/shared/toolResultLimit.ts), never by reading the stored limit fields.
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

describe('one rule for the tool result size limit', () => {
  it('server code never reads the stored limit fields directly', () => {
    const offenders = sourceFiles(SERVER_ROOT).flatMap((file) => fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (RAW_LIMIT_READ.test(line)
        ? [`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`]
        : [])));
    if (offenders.length > 0) {
      throw new Error('Use resolveToolResultBound (src/shared/toolResultLimit.ts) instead of reading the '
        + `tool result limit fields:\n${offenders.join('\n')}`);
    }
  });
});
