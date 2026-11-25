#!/usr/bin/env node
// Model-checks the TLA+ specifications in docs/formal with TLC (see docs/formal/README.md).
//
// Every `<Module>.<name>.cfg` starts with `\* expect: ok` or `\* expect: violation`.
// "ok" configurations must check clean. "violation" configurations switch a
// fixed bug back on, and TLC must find it; that keeps the properties honest.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAL_DIR = 'docs/formal';
export const TLA_TOOLS = Object.freeze({
  version: 'v1.7.4',
  url: 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar',
  sha256: '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88',
});
export const MIN_JAVA = 11;

const JAVA_HELP = `TLC needs Java ${MIN_JAVA} or newer. Install one (for example Eclipse Temurin 21 from https://adoptium.net),
then put \`java\` on PATH or set JAVA_HOME. GitHub's ubuntu-24.04 runners already have it.`;

/** `\* expect: ok` or `\* expect: violation` on the first line of a configuration. */
export function parseExpectation(config) {
  const match = /^\\\*\s*expect:\s*(ok|violation)\s*$/m.exec(config.split(/\r?\n/, 1)[0] ?? '');
  return match?.[1];
}

/** TLC exit codes: 0 no error, 11-14 a deadlock, invariant, temporal property or assert violation. */
export function classifyExit(code) {
  if (code === 0) return 'ok';
  if (code >= 11 && code <= 14) return 'violation';
  return 'error';
}

/** Major version from `java -version` output ("1.8.0_151" is 8, "21.0.2" is 21). */
export function javaMajorVersion(output) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return undefined;
  const major = Number(match[1]);
  return major === 1 ? Number(match[2]) : major;
}

export function javaCommand(env = process.env) {
  return env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
}

function checkJava(java) {
  const probe = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const version = probe.error ? undefined : javaMajorVersion(`${probe.stderr}${probe.stdout}`);
  if (version === undefined) throw new Error(`Could not run ${java}. ${JAVA_HELP}`);
  if (version < MIN_JAVA) throw new Error(`${java} is Java ${version}. ${JAVA_HELP}`);
  return version;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The pinned official tla2tools.jar, downloaded once into a cache outside the repository. */
export async function ensureTlaTools(cacheRoot = process.env.FLUJO_TLA_TOOLS_DIR
  ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'flujo', 'tla2tools')) {
  const directory = path.join(cacheRoot, TLA_TOOLS.version);
  const jar = path.join(directory, 'tla2tools.jar');
  const cached = await readFile(jar).catch(() => undefined);
  if (cached && sha256(cached) === TLA_TOOLS.sha256) return jar;
  console.log(`Downloading TLA+ tools ${TLA_TOOLS.version} from ${TLA_TOOLS.url}`);
  const response = await fetch(TLA_TOOLS.url);
  if (!response.ok) throw new Error(`Download of ${TLA_TOOLS.url} failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== TLA_TOOLS.sha256) {
    throw new Error(`tla2tools.jar has SHA-256 ${digest}, expected ${TLA_TOOLS.sha256}. Refusing to run an unverified checker.`);
  }
  await mkdir(directory, { recursive: true });
  const partial = `${jar}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, jar);
  return jar;
}

async function runTlc(java, jar, cwd, spec, config) {
  // TLC's state files go to a temporary folder, never next to the specification.
  const metadir = await mkdtemp(path.join(os.tmpdir(), 'flujo-tlc-'));
  try {
    return await new Promise((resolve, reject) => {
      const output = [];
      const child = spawn(java, ['-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC', '-workers', 'auto',
        '-metadir', metadir, '-config', config, spec], { cwd });
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stderr.on('data', (chunk) => output.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output: Buffer.concat(output).toString('utf8') }));
    });
  } finally {
    await rm(metadir, { recursive: true, force: true });
  }
}

const summary = (output) => output.split(/\r?\n/)
  .filter((line) => /distinct states found|^Error:|is violated|No error has been found|Finished in/.test(line))
  .join('\n  ');

export async function run({ cwd = process.cwd(), only = process.argv.slice(2), log = console.log, error = console.error } = {}) {
  const java = javaCommand();
  log(`Using ${java} (Java ${checkJava(java)}).`);
  const jar = await ensureTlaTools();
  const directory = path.join(cwd, FORMAL_DIR);
  const configs = (await readdir(directory)).filter((name) => name.endsWith('.cfg')
    && (!only.length || only.some((filter) => name.includes(filter)))).sort();
  if (!configs.length) throw new Error(`No TLC configurations in ${FORMAL_DIR}${only.length ? ` match ${only.join(', ')}` : ''}.`);
  let failures = 0;
  for (const config of configs) {
    const expected = parseExpectation(await readFile(path.join(directory, config), 'utf8'));
    const spec = `${config.split('.')[0]}.tla`;
    if (!expected) {
      error(`${FORMAL_DIR}/${config}: start it with "\\* expect: ok" or "\\* expect: violation".`);
      failures++;
      continue;
    }
    const started = Date.now();
    const { code, output } = await runTlc(java, jar, directory, spec, config);
    const outcome = classifyExit(code);
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    if (outcome === expected) {
      log(`${config}: ${expected === 'ok' ? 'checked clean' : 'TLC found the reintroduced bug, as expected'} (${seconds}s)\n  ${summary(output)}`);
      continue;
    }
    failures++;
    const reason = outcome === 'error' ? `TLC could not check it (exit ${code})`
      : expected === 'ok' ? 'TLC found a violation. The trace below is the shortest way to reach it; fix the code or the model'
        : 'TLC found no violation, so the properties no longer catch the bug this configuration switches back on';
    error(`${config}: ${reason}.\n${output}`);
  }
  return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then((code) => { process.exitCode = code; }, (failure) => {
    console.error(failure instanceof Error ? failure.message : failure);
    process.exitCode = 1;
  });
}
