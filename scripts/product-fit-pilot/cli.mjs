import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { emptyPilot, publicSummary, summarizePilot } from './evidence.mjs';

const MAX_BYTES = 4 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'Usage: node scripts/product-fit-pilot/cli.mjs init --out <private-file> | report --input <private-file> --as-of <UTC-ISO-time> [--private-output <new-private-file>]';

async function readBounded(path) {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Input must be a regular file.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('Input exceeds the 4 MiB limit.');
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function writeNew(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

export async function main(args) {
  const [command, ...options] = args;
  if (command === '--help' && options.length === 0) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (!['init', 'report'].includes(command) || options.length % 2 !== 0) throw new Error(usage);
  const allowed = command === 'init' ? ['--out'] : ['--input', '--as-of', '--private-output'];
  const flags = new Map();
  for (let i = 0; i < options.length; i += 2) {
    if (!allowed.includes(options[i]) || flags.has(options[i]) || !options[i + 1] || options[i + 1].startsWith('--')) {
      throw new Error(usage);
    }
    flags.set(options[i], options[i + 1]);
  }
  if (command === 'init') {
    if (!flags.has('--out')) throw new Error(usage);
    await writeNew(flags.get('--out'), emptyPilot());
    process.stdout.write('Created a proposed pilot with no enrollment or observations.\n');
    return;
  }
  if (!flags.has('--input') || !flags.has('--as-of')) throw new Error(usage);
  const input = await readBounded(flags.get('--input'));
  let data;
  try { data = JSON.parse(input.toString('utf8')); }
  catch { throw new Error('Input is not valid JSON; content is withheld.'); }
  const report = summarizePilot(data, flags.get('--as-of'));
  if (flags.has('--private-output')) {
    const validator = await readFile(new URL('./evidence.mjs', import.meta.url));
    const cli = await readFile(new URL('./cli.mjs', import.meta.url));
    await writeNew(flags.get('--private-output'), { ...report, inputSha256: sha256(input),
      toolSha256: { evidence: sha256(validator), cli: sha256(cli) } });
  }
  process.stdout.write(`${JSON.stringify(publicSummary(data, report), null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    // OS errors contain paths; JSON parse errors may contain original content.
    const message = error?.code ? 'File operation failed; check access, input existence, and unused output paths.' : error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
