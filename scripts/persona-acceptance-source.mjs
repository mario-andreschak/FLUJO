import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

async function streamGit(args, cwd, consume) {
  const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`Persona source fingerprint failed: git ${args[0]} exited ${signal ?? code}. ${stderr.trim()}`));
    });
  });
  try {
    await Promise.all([
      completion,
      (async () => { for await (const chunk of child.stdout) consume(chunk); })(),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
}

/** Diagnostic source identity includes the entire binary diff, without execFile's output cap. */
export async function hashPersonaAcceptanceSourceDiff(cwd = process.cwd()) {
  const hash = createHash('sha256');
  await streamGit(['-c', 'core.safecrlf=false', 'diff', '--binary', 'HEAD'], cwd, (chunk) => hash.update(chunk));
  const paths = [];
  await streamGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd, (chunk) => paths.push(chunk));
  const untracked = Buffer.concat(paths).toString('utf8').split('\0')
    .filter((name) => /^(?:src|scripts|__tests__|docs|\.github)\//.test(name));
  for (const name of untracked.sort()) {
    hash.update(name);
    for await (const chunk of createReadStream(path.resolve(cwd, name))) hash.update(chunk);
  }
  return hash.digest('hex');
}

/** A HEAD label is not exact-commit evidence when the executed tree differs. */
export function assertExactPersonaAcceptanceSource(expectedCommit, cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== expectedCommit) {
    throw new Error('The checkout commit changed during Persona acceptance. Run again from the intended release commit.');
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Exact-commit Persona acceptance requires a clean checkout, including untracked files. Use --infrastructure for a local soak diagnostic, or run acceptance in a clean checkout. Store artifacts outside the checkout or in an ignored directory.');
  }
}
