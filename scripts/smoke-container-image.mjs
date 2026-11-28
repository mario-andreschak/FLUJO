#!/usr/bin/env node
// Container smoke (#1408). Starts a built FLUJO image the size of a small cloud machine (1 CPU,
// 2 GB), checks that it ships the declared Node version from the recorded official base, that its
// own health check turns healthy and that its published port answers. Then
// scripts/container-smoke/inside.mjs runs, inside the container, a first chat and the voice-app
// check (Claude subscription model through the bundled Claude Code and one MCP tool, held to fixed
// limits) against local stand-ins. Finally the container is killed and started
// again, and every finished turn must still be there. No account, key or outside service is used
// beyond the registry the image was built from.
//
// Usage: node scripts/smoke-container-image.mjs --image <image id or reference> [--report <file>] [--keep]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RESULT_PREFIX, STAND_IN_PORTS, TRACE_FILE, describeVoiceLimits, median } from './container-smoke/inside.mjs';
import { delay, unusedPort } from './packaged-acceptance/targets.mjs';
import { assertContainerBaseIndex, containerBaseRecord, shippedNodeRuntimes } from './verify-ci-node.mjs';

export const USAGE = 'Usage: node scripts/smoke-container-image.mjs --image <image id or reference> [--report <file>] [--keep]';
/** The voice app's test machine: 1 performance vCPU, 2 GB. */
export const MACHINE = Object.freeze({ cpus: '1', memory: '2g' });
const LABEL = 'io.flujo.container-smoke';
const HEALTH_DEADLINE_MS = 5 * 60_000;

export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    image: { type: 'string' }, report: { type: 'string' }, keep: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) return { help: true };
  if (!values.image || !/^[\w./:@-]+$/.test(values.image)) throw new Error(`--image needs an image id or reference.\n${USAGE}`);
  if (values.report !== undefined && !path.isAbsolute(values.report)) throw new Error(`--report needs an absolute path.\n${USAGE}`);
  return { image: values.image, report: values.report, keep: Boolean(values.keep) };
}

/** Run docker and keep its exit code and output; the caller decides what a failure means. */
export function docker(args, { timeoutMs = 120_000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (bytes) => { stdout = (stdout + bytes).slice(-4 * 1024 * 1024); });
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-64 * 1024); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? signal, stdout, stderr }); });
  });
}

async function dockerOk(args, options) {
  const result = await docker(args, options);
  if (result.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} exited with ${result.code}: ${result.stderr.trim().slice(-2000)}`);
  return result.stdout.trim();
}

/** The last result line `inside.mjs` printed. */
export function readPhaseResult(stdout) {
  const line = stdout.split(/\r?\n/).filter((item) => item.startsWith(RESULT_PREFIX)).at(-1);
  if (!line) return undefined;
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

const REGISTRIES = Object.freeze([
  { name: 'mirror.gcr.io', manifest: (digest) => `https://mirror.gcr.io/v2/library/node/manifests/${digest}` },
  { name: 'Docker Hub', token: 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull',
    manifest: (digest) => `https://registry-1.docker.io/v2/library/node/manifests/${digest}` },
]);

/** Fetch the pinned base index from the registry and check it against the recorded observation. */
export async function checkContainerBase({ fetchImpl = fetch, pause = delay, record = containerBaseRecord() } = {}) {
  const failures = [];
  for (const registry of REGISTRIES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const headers = { accept: `${record.mediaType}, application/vnd.docker.distribution.manifest.list.v2+json` };
        if (registry.token) {
          const token = await fetchImpl(registry.token, { signal: AbortSignal.timeout(30_000) }).then((response) => response.json());
          headers.authorization = `Bearer ${token.token}`;
        }
        const response = await fetchImpl(registry.manifest(record.digest), { headers, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`answered ${response.status}`);
        const amd64 = assertContainerBaseIndex(Buffer.from(await response.arrayBuffer()), record);
        return { reference: record.reference, registry: registry.name, linuxAmd64: amd64 };
      } catch (error) {
        if (/pinned container base/.test(error.message)) throw error;
        failures.push(`${registry.name}: ${error.message}`);
        if (attempt < 3) await pause(attempt * 2_000);
      }
    }
  }
  throw new Error(`The pinned container base could not be read from any registry: ${failures.join('; ')}`);
}

async function containerState(name) {
  const result = await docker(['inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name]);
  const [status = 'missing', health = 'none'] = result.code === 0 ? result.stdout.trim().split(' ') : [];
  return { status, health };
}

/** Wait for the image's own HEALTHCHECK to report healthy; a stopped container fails at once. */
async function waitHealthy(name, logs) {
  const started = performance.now();
  for (;;) {
    const state = await containerState(name);
    if (state.health === 'healthy') return Math.round(performance.now() - started);
    if (state.status !== 'running') throw new Error(`The container stopped (${state.status}) before it was healthy.\n${await logs()}`);
    if (state.health === 'none') throw new Error('The image has no health check.');
    if (performance.now() - started > HEALTH_DEADLINE_MS) {
      throw new Error(`The health check did not pass within ${HEALTH_DEADLINE_MS / 60_000} minutes (${state.health}).\n${await logs()}`);
    }
    await delay(2_000);
  }
}

async function publishedPortAnswers(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/cwd`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => undefined);
  if (response.status !== 200 || body?.success !== true) throw new Error(`The published port answered ${response.status} on /api/cwd.`);
}

const fmt = (value) => (value === undefined ? '-' : String(value));

/** A short Markdown summary of the report, for the log and the CI job summary. */
export function summarize(report) {
  const lines = [`## Container smoke: ${report.result}`, '',
    `Image ${report.imageId ?? report.image}, Node ${report.node ?? '?'}, ${MACHINE.cpus} CPU, ${MACHINE.memory} memory.`, ''];
  for (const check of report.checks) lines.push(`- ${check.result === 'passed' ? 'PASS' : 'FAIL'} ${check.title}${check.error ? `: ${check.error.split('\n')[0]}` : ''}`);
  const voice = report.phases?.voice;
  if (voice?.scenarios) {
    lines.push('', 'Voice check (Claude subscription model through the bundled Claude Code, stand-in model service; ms, median of runs 2 and later):', '',
      '| turn | first run | later runs | until the model request | ready Claude process taken | MCP list requests | conversation saves |',
      '|---|---:|---:|---:|---:|---:|---:|');
    for (const scenario of ['direct', 'tool', 'continue']) {
      const runs = voice.scenarios[scenario]?.runs ?? [];
      const later = runs.slice(1);
      lines.push(`| ${scenario} | ${fmt(runs[0]?.totalMs)} | ${fmt(median(later.map((run) => run.totalMs)))} | `
        + `${fmt(median(later.map((run) => run.beforeModelMs)))} | ${later.filter((run) => run.claimed).length} of ${later.length} | `
        + `${fmt(median(later.map((run) => run.mcpLists)))} | ${fmt(median(later.map((run) => run.saves)))} |`);
    }
    if (voice.limits) lines.push('', `Limits: ${describeVoiceLimits(voice.limits)}.`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log(USAGE); return 0; }
  const name = `flujo-container-smoke-${randomUUID().slice(0, 8)}`;
  const report = { schemaVersion: 1, kind: 'flujo-container-smoke', image: options.image, machine: MACHINE,
    startedAt: new Date().toISOString(), checks: [], phases: {}, result: 'failed' };
  let created = false;
  const logs = async () => (created ? (await docker(['logs', '--tail', '150', name])).stdout.slice(-12_000) : '');
  const check = async (title, operation) => {
    const entry = { title, result: 'failed' };
    report.checks.push(entry);
    const started = performance.now();
    try {
      const details = await operation();
      if (details !== undefined) entry.details = details;
      entry.result = 'passed';
    } catch (error) {
      entry.error = error.message;
      throw error;
    } finally {
      entry.seconds = Math.round((performance.now() - started) / 100) / 10;
      console.log(`${entry.result === 'passed' ? 'PASS' : 'FAIL'}  ${title} (${entry.seconds} s)`);
    }
  };
  const phase = (title, phaseName, state) => check(title, async () => {
    const result = await docker(['exec', name, 'node', 'scripts/container-smoke/inside.mjs', phaseName, ...(state ? [JSON.stringify(state)] : [])],
      { timeoutMs: 20 * 60_000 });
    const parsed = readPhaseResult(result.stdout);
    if (!parsed?.ok) {
      throw new Error(`${parsed?.error ?? `inside.mjs ${phaseName} exited with ${result.code} without a result: ${result.stderr.slice(-2000)}`}\n${await logs()}`);
    }
    report.phases[phaseName] = parsed;
    return parsed.checks;
  });
  try {
    const { container } = shippedNodeRuntimes();
    report.imageId = await dockerOk(['image', 'inspect', '--format', '{{.Id}}', options.image]);
    await check(`The image runs the shipped Node ${container}`, async () => {
      report.node = await dockerOk(['run', '--rm', '--network', 'none', '--entrypoint', 'node', report.imageId, '--version']);
      if (report.node !== `v${container}`) throw new Error(`The image runs Node ${report.node}, not the shipped ${container}.`);
    });
    await check('The pinned base is the recorded official node image', () => checkContainerBase());
    const port = await unusedPort();
    await check(`The container starts on ${MACHINE.cpus} CPU and ${MACHINE.memory} and its health check passes`, async () => {
      await dockerOk(['run', '--detach', '--name', name, '--label', `${LABEL}=1`, '--cpus', MACHINE.cpus, '--memory', MACHINE.memory,
        '--publish', `127.0.0.1:${port}:4200`,
        // Claude Code sends its model requests to the stand-in; the subscription token stays a placeholder.
        '--env', `ANTHROPIC_BASE_URL=http://127.0.0.1:${STAND_IN_PORTS.anthropic}`, '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        '--env', 'DISABLE_AUTOUPDATER=1', '--env', `FLUJO_TURN_TRACE_FILE=${TRACE_FILE}`, report.imageId]);
      created = true;
      return { healthyAfterMs: await waitHealthy(name, logs) };
    });
    await check('The published port answers', () => publishedPortAnswers(port));
    await phase('A first chat answers through a flow and directly', 'first-chat');
    await phase('The voice check answers within its fixed limits', 'voice');
    await check('A hard stop and a new start keep every finished turn', async () => {
      await dockerOk(['kill', name]);
      await dockerOk(['start', name]);
      const healthyAfterMs = await waitHealthy(name, logs);
      const conversations = ['first-chat', 'voice'].flatMap((key) => report.phases[key]?.conversations ?? []);
      const result = await docker(['exec', name, 'node', 'scripts/container-smoke/inside.mjs', 'verify', JSON.stringify({ conversations })],
        { timeoutMs: 10 * 60_000 });
      const parsed = readPhaseResult(result.stdout);
      if (!parsed?.ok) throw new Error(`${parsed?.error ?? `verify exited with ${result.code}: ${result.stderr.slice(-2000)}`}\n${await logs()}`);
      report.phases.verify = parsed;
      return { healthyAfterMs, checks: parsed.checks };
    });
    report.result = 'passed';
  } catch (error) {
    report.failure = error.message;
  } finally {
    if (created && !options.keep) {
      const removed = await docker(['rm', '--force', name]);
      if (removed.code !== 0) report.cleanup = `Could not remove container ${name}: ${removed.stderr.trim()}`;
    } else if (created) {
      console.log(`Kept container ${name}.`);
    }
    report.completedAt = new Date().toISOString();
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  const summary = summarize(report);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary).catch(() => undefined);
  if (report.result !== 'passed') {
    console.error(`Container smoke failed: ${report.failure}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
}
