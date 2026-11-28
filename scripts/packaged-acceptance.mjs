#!/usr/bin/env node
// Backup, restart, upgrade, disk-full, schedule and restore checks against FLUJO
// as it is shipped: the installed npm package, an installed source checkout
// (what the Windows and shell installers leave behind) or the Docker image. All
// forms run the same checks; see scripts/packaged-acceptance/checks.mjs and the
// "Checks on the shipped forms" section of docs/operations/production-operations.md.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runAcceptance } from './packaged-acceptance/checks.mjs';
import { createFlujoProbe } from './packaged-acceptance/flujo-probe.mjs';
import { createDockerVolume, createHostVolume } from './packaged-acceptance/low-disk.mjs';
import { startStandIns } from './packaged-acceptance/stand-ins.mjs';
import {
  DOCKER_HOST_NAME, OWNER_LABEL, assertHostIdentity, createDockerTarget, createHostTarget, dockerCommand, dockerStandInHost,
  hostEnvironment, hostLaunch, installNpmPackages, isImageReference, packCandidate, prepareDockerImage, prepareHostSandbox,
  readCandidateTarballs, resolveNpmCli, unusedPort,
} from './packaged-acceptance/targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `Usage:
  node scripts/packaged-acceptance.mjs --form npm (--pack | --tarballs DIR) [--from npm:VERSION] [--node FILE] [--report FILE] [--keep]
  node scripts/packaged-acceptance.mjs --form checkout --app-root DIR [--from npm:VERSION] [--node FILE] [--report FILE] [--keep]
  node scripts/packaged-acceptance.mjs --form docker --image IMAGE [--from image:IMAGE] [--report FILE] [--keep]

--pack packs this checkout's finished build (run "npm run build" first).
--tarballs takes a release candidate folder with manifest.json.
--from adds the upgrade check: the previous release writes the data first.
VERSION is "latest" or an exact version such as 3.48.10. Paths must be absolute.

The data folder lives on a small volume that the disk-full check fills: a tmpfs
on Linux (root or passwordless sudo), a virtual disk on Windows (an
administrator shell), a disk image on macOS, a tmpfs volume for Docker.`;

const FORM_OPTIONS = Object.freeze({
  npm: ['pack', 'tarballs', 'from', 'node'],
  checkout: ['app-root', 'from', 'node'],
  docker: ['image', 'from'],
});

export function parseOptions(argv) {
  const fail = message => { throw new Error(`${message}\n\n${USAGE}`); };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      form: { type: 'string' }, pack: { type: 'boolean' }, tarballs: { type: 'string' }, 'app-root': { type: 'string' },
      image: { type: 'string' }, from: { type: 'string' }, node: { type: 'string' }, report: { type: 'string' },
      keep: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
  } catch (error) { fail(error.message); }
  if (values.help) return { help: true };
  const absolute = name => {
    if (values[name] !== undefined && !path.isAbsolute(values[name])) fail(`--${name} needs an absolute path.`);
    return values[name];
  };
  const { form } = values;
  if (!Object.hasOwn(FORM_OPTIONS, form ?? '')) fail('Choose --form npm, checkout or docker.');
  for (const name of ['pack', 'tarballs', 'app-root', 'image', 'from', 'node']) {
    if (values[name] !== undefined && !FORM_OPTIONS[form].includes(name)) fail(`--${name} does not apply to --form ${form}.`);
  }
  const options = { form, keep: Boolean(values.keep), report: absolute('report'), node: absolute('node') };
  if (form === 'npm') {
    if (Boolean(values.pack) === (values.tarballs !== undefined)) fail('Give either --pack or --tarballs DIR.');
    options.pack = Boolean(values.pack);
    options.tarballs = absolute('tarballs');
  } else if (form === 'checkout') {
    if (!values['app-root']) fail('--app-root DIR is required.');
    options.appRoot = absolute('app-root');
  } else if (!isImageReference(values.image)) {
    fail('--image needs an image ID (sha256:...) or an image reference.');
  } else {
    options.image = values.image;
  }
  if (values.from !== undefined) {
    const kind = form === 'docker' ? 'image' : 'npm';
    const match = /^(npm|image):(.+)$/.exec(values.from);
    if (!match || match[1] !== kind) fail(`--from must start with ${kind}: for --form ${form}.`);
    if (kind === 'npm' && !/^(?:latest|\d+\.\d+\.\d+)$/.test(match[2])) fail('--from npm: needs "latest" or an exact version such as 3.48.10.');
    if (kind === 'image' && !isImageReference(match[2])) fail('--from image: needs an image reference.');
    options.from = { kind, value: match[2] };
  }
  return options;
}

/** Use the repository's jszip, or the copy installed with the app under test. */
export function loadJSZip(directories) {
  for (const directory of directories) {
    try { return createRequire(path.join(directory, 'package.json'))('jszip'); } catch { /* try the next folder */ }
  }
  throw new Error('jszip was not found. Run "npm ci" in this checkout or point the check at an installed app.');
}

function gitRevision(directory) {
  try { return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; }
}

async function distinctPorts() {
  const port = await unusedPort();
  let sandboxPort = await unusedPort();
  while (sandboxPort === port) sandboxPort = await unusedPort();
  return { port, sandboxPort };
}

/**
 * Host forms keep their data folder on the small volume and reach the
 * stand-ins on loopback. `setup.cleanups` collects what to undo, newest last.
 */
async function hostTargets(options, sandbox, report, setup) {
  await prepareHostSandbox(sandbox);
  const volume = await createHostVolume({ workDirectory: path.join(sandbox, 'low-disk') });
  setup.cleanups.push(['small volume', () => volume.remove()]);
  setup.volume = volume;
  const dataDir = path.join(volume.root, 'data');
  await mkdir(dataDir);
  const standIns = await startStandIns();
  setup.cleanups.push(['stand-ins', () => standIns.close()]);
  setup.standIns = standIns;
  const { port, sandboxPort } = await distinctPorts();
  const env = hostEnvironment({ sandbox, dataDir, sandboxPort, node: options.node, snapshotToken: randomBytes(32).toString('base64url') });
  const npmCli = options.form === 'npm' || options.from ? await resolveNpmCli() : undefined;
  const host = (label, form, appRoot) => createHostTarget({
    label, launch: hostLaunch({ form, appRoot, port, node: options.node }), cwd: appRoot, env, port,
    logDirectory: path.join(sandbox, 'logs'), identity: observed => assertHostIdentity(observed, { appRoot, dataDir }),
  });
  let candidateRoot;
  if (options.form === 'npm') {
    const directory = options.pack ? path.join(sandbox, 'tarballs') : options.tarballs;
    if (options.pack) await packCandidate({ root, directory, npmCli });
    const { tarballs, revision } = await readCandidateTarballs(directory);
    const installed = await installNpmPackages({ consumer: path.join(sandbox, 'candidate'), specs: tarballs, npmCli });
    candidateRoot = installed.appRoot;
    report.candidate = { package: `flujo-ai@${installed.version}`, revision, tarballs: tarballs.map(file => path.basename(file)) };
  } else {
    candidateRoot = await realpath(options.appRoot);
    const { version } = JSON.parse(await readFile(path.join(candidateRoot, 'package.json'), 'utf8'));
    report.candidate = { appRoot: candidateRoot, version, revision: gitRevision(candidateRoot) };
  }
  setup.candidate = host('release under test', options.form, candidateRoot);
  setup.appRoots = [candidateRoot];
  if (options.from) {
    const installed = await installNpmPackages({ consumer: path.join(sandbox, 'previous'), specs: [`flujo-ai@${options.from.value}`], npmCli });
    setup.previous = host('previous release', 'npm', installed.appRoot);
    setup.appRoots.push(installed.appRoot);
    report.previous = { package: `flujo-ai@${installed.version}` };
  }
}

/** Containers keep their data on a small tmpfs volume and reach the stand-ins through the host gateway. */
async function dockerTargets(options, report, setup) {
  const { port } = await distinctPorts();
  const name = `flujo-acceptance-${randomUUID().slice(0, 8)}`;
  const imageId = await prepareDockerImage(options.image);
  report.candidate = { image: options.image, imageId };
  const volume = createDockerVolume({ name, image: imageId, docker: dockerCommand, label: `${OWNER_LABEL}=volume` });
  setup.cleanups.push(['small volume', () => volume.remove()]);
  await volume.prepare();
  setup.volume = volume;
  setup.candidate = createDockerTarget({ label: 'release under test', image: imageId, name, mount: volume.mount, port });
  await setup.candidate.prepare();
  const standIns = await startStandIns({ host: await dockerStandInHost(), appHost: DOCKER_HOST_NAME });
  setup.cleanups.push(['stand-ins', () => standIns.close()]);
  setup.standIns = standIns;
  setup.appRoots = [];
  if (options.from) {
    setup.previous = createDockerTarget({ label: 'previous release', image: options.from.value, name: `${name}-previous`, mount: volume.mount, port });
    await setup.previous.prepare();
    report.previous = { image: options.from.value, imageId: setup.previous.imageId };
  }
}

function printCheck(entry) {
  const mark = entry.result === 'passed' ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${entry.title} (${entry.seconds} s)${entry.error ? `\n      ${entry.error.split('\n')[0]}` : ''}`);
}

/** Stop every app copy, then undo the set-up newest first; failures are noted, never hidden. */
async function cleanUp(setup, report) {
  for (const target of [setup.candidate, setup.previous].filter(Boolean)) {
    try { await target.dispose(); } catch (error) { report.cleanup.push(`${target.label}: ${error.message}`); }
  }
  for (const [label, undo] of setup.cleanups.splice(0).reverse()) {
    try { await undo(); } catch (error) { report.cleanup.push(`${label}: ${error.message}`); }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log(USAGE); return 0; }
  const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'flujo-packaged-acceptance-')));
  const report = { schemaVersion: 2, kind: 'flujo-packaged-acceptance', form: options.form, platform: process.platform,
    arch: process.arch, node: process.version, startedAt: new Date().toISOString(), candidate: null, previous: null,
    checks: [], result: 'failed' };
  const setup = { cleanups: [] };
  const cleanupNotes = [];
  const interrupt = signal => {
    cleanUp(setup, { cleanup: cleanupNotes }).finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  console.log(`Packaged acceptance: ${options.form}${options.from ? `, upgrade from ${options.from.kind}:${options.from.value}` : ''}`);
  try {
    if (options.form === 'docker') await dockerTargets(options, report, setup);
    else await hostTargets(options, sandbox, report, setup);
    report.volume = setup.volume.description;
    const probe = createFlujoProbe({ JSZip: loadJSZip([root, ...setup.appRoots]) });
    Object.assign(report, await runAcceptance({ candidate: setup.candidate, previous: setup.previous, probe,
      volume: setup.volume, standIns: setup.standIns, log: printCheck }));
  } catch (error) {
    report.result = 'failed';
    report.failure ??= error.message;
  } finally {
    report.cleanup ??= [];
    await cleanUp(setup, report);
    if (report.cleanup.length) report.result = 'failed';
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    report.completedAt = new Date().toISOString();
    if (options.report) {
      await mkdir(path.dirname(options.report), { recursive: true });
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (options.keep) console.log(`Kept the test folder: ${sandbox}`);
    else {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
        .catch(error => console.warn(`Could not remove the test folder ${sandbox}: ${error.message}`));
    }
  }
  for (const entry of report.checks.filter(item => item.result === 'not-run')) console.log(`SKIP  ${entry.title} (not run after an earlier failure)`);
  for (const stop of report.stops ?? []) {
    if (stop.leftoverHelpers) console.warn(`Note: helper processes of ${stop.target} were still running after its ${stop.kind} and were ended.`);
  }
  if (report.result !== 'passed') {
    console.error(`\nPackaged acceptance failed: ${report.failure ?? 'see the cleanup notes in the report'}`);
    for (const [label, text] of Object.entries(report.diagnostics ?? {})) {
      if (text) console.error(`\nLast output of ${label}:\n${text}`);
    }
    for (const note of report.cleanup ?? []) console.error(`Cleanup: ${note}`);
    return 1;
  }
  console.log(`\nAll ${report.checks.length} checks passed.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
