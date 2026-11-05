/**
 * `flujo service install | uninstall | status | start | stop | run`
 *
 * Keeps one named instance running with nobody there: its own data directory and
 * port, started by the operating system, restarted after a crash, no browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import nextEnv from '@next/env';
import { loadBootstrapEnvironment } from '../../scripts/bootstrap-directory.mjs';
import { localInstanceDirectory } from '../../scripts/local-instance.mjs';
import {
  absoluteDirectory, CliError, defaultServiceRoot, isProcessAlive, isSameOrInside, killProcessTree,
  readJsonIfPresent, report, sleep, validatePort, validateServiceName, writeFileAtomicSync, writeJsonAtomicSync,
} from './common.mjs';
import { packageRootOfThisFile, prepareManagedRoot, readCurrent, readServiceRecord, rootPaths } from './managed-root.mjs';
import { runSupervisor, stopLeftovers } from './supervisor.mjs';
import {
  endWindowsTask, installWindowsTask, removeWindowsTask, startWindowsTask, taskNameFor, windowsTaskStatus,
} from './service-windows.mjs';
import { installSystemdUnit, removeSystemdUnit, startSystemdUnit, stopSystemdUnit, systemdStatus, unitNameFor } from './service-linux.mjs';

const USAGE = `Usage:
  flujo service install --name <name> --data-dir <folder> --port <port> [--mode auto|boot|logon|timer] [--root <folder>] [--no-start] [--run-as <user>] [--json]
  flujo service status --name <name> [--root <folder>] [--json]
  flujo service start --name <name> [--root <folder>] [--json]
  flujo service stop --name <name> [--root <folder>] [--json]
  flujo service uninstall --name <name> [--root <folder>] [--purge] [--json]

The data directory is never deleted. --purge also removes logs, old versions and
update backups of this instance.`;

const OPTIONS = {
  name: { type: 'string' },
  'data-dir': { type: 'string' },
  port: { type: 'string' },
  mode: { type: 'string', default: 'auto' },
  root: { type: 'string' },
  'run-as': { type: 'string' },
  'no-start': { type: 'boolean', default: false },
  purge: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const STOP_WAIT_MS = 40_000;

function resolveRoot(name, rootOption) {
  return rootOption ? absoluteDirectory(rootOption, '--root') : defaultServiceRoot(name);
}

function stopRecord(paths) {
  writeFileAtomicSync(paths.stopRequest, `${new Date().toISOString()}\n`);
}

/** Wait for the supervisor to finish; if it will not, end it and clean up. */
export async function stopInstance({ name, root, record, platform = process.platform, waitMs = STOP_WAIT_MS }) {
  const paths = rootPaths(root);
  stopRecord(paths);
  if (platform === 'linux') stopSystemdUnit(name);
  const deadline = Date.now() + waitMs;
  const supervisorAlive = () => isProcessAlive(readJsonIfPresent(paths.state)?.supervisorPid) && fs.existsSync(paths.lock);
  while (supervisorAlive() && Date.now() < deadline) await sleep(250);
  let forced = false;
  if (supervisorAlive()) {
    forced = true;
    killProcessTree(readJsonIfPresent(paths.state)?.supervisorPid, { signal: 'SIGKILL' });
  }
  if (platform === 'win32') endWindowsTask(name);
  if (record) {
    stopLeftovers({ root, dataDir: record.dataDir, port: record.port, instanceDirectory: localInstanceDirectory() });
  }
  return { forced };
}

export function startInstance({ name, root, platform = process.platform }) {
  fs.rmSync(rootPaths(root).stopRequest, { force: true });
  return platform === 'win32' ? startWindowsTask(name) : startSystemdUnit(name);
}

async function probe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/cwd`, { redirect: 'error', signal: AbortSignal.timeout(4_000) });
    if (response.status === 423) return 'locked';
    if (response.status === 401 || response.status === 403) return 'needs-login';
    return response.ok ? 'ready' : 'not-ready';
  } catch { return 'not-answering'; }
}

async function install(values, { platform, root, name }) {
  const dataDir = absoluteDirectory(values['data-dir'], '--data-dir');
  const port = validatePort(values.port);
  if (!['auto', 'boot', 'logon', 'timer'].includes(values.mode)) throw new CliError('--mode must be auto, boot, logon or timer.');
  if (isSameOrInside(dataDir, root)) throw new CliError('--root must be outside the data directory, so logs and old versions stay out of data backups.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const paths = prepareManagedRoot(root);
  const serviceArgs = ['service', 'run', '--name', name, '--data-dir', dataDir, '--port', String(port), '--root', root];
  let registration;
  if (platform === 'win32') {
    registration = installWindowsTask({
      name, requestedMode: values.mode, nodePath: process.execPath, launcher: paths.launcher, serviceArgs, workingDirectory: root,
    });
  } else if (platform === 'linux') {
    registration = installSystemdUnit({
      name, nodePath: process.execPath, launcher: paths.launcher, serviceArgs, workingDirectory: root, runAs: values['run-as'],
    });
  } else {
    throw new CliError('Autostart is available on Windows and Linux. This system is neither.');
  }
  const record = { name, dataDir, port, root, mode: registration.mode, nodePath: process.execPath, installedAt: new Date().toISOString() };
  writeJsonAtomicSync(paths.service, record);
  fs.rmSync(paths.stopRequest, { force: true });
  let started = false;
  if (!values['no-start']) started = platform === 'win32' ? startWindowsTask(name) : startSystemdUnit(name);
  const result = { ...record, started, explanation: registration.explanation, logFile: paths.logFile, ...(registration.notes?.length ? { notes: registration.notes } : {}) };
  report(result, values.json, [
    `FLUJO instance "${name}" is set up: port ${port}, data in ${dataDir}.`,
    `Start mode: ${registration.mode}. ${registration.explanation}`,
    started ? 'It is starting now.' : 'It has not been started yet. Use: flujo service start --name ' + name,
    `Log: ${paths.logFile}`,
    ...(registration.notes ?? []),
  ]);
  return 0;
}

async function status(values, { platform, root, name }) {
  const paths = rootPaths(root);
  const record = readServiceRecord(root);
  const entry = platform === 'win32' ? windowsTaskStatus(name) : systemdStatus(name);
  const state = readJsonIfPresent(paths.state);
  const health = record ? await probe(record.port) : 'unknown';
  const result = {
    name,
    installed: entry.installed === true,
    entryName: platform === 'win32' ? taskNameFor(name) : unitNameFor(name),
    entry,
    mode: record?.mode ?? null,
    dataDir: record?.dataDir ?? null,
    port: record?.port ?? null,
    version: readCurrent(root)?.version ?? null,
    health,
    stoppedOnPurpose: fs.existsSync(paths.stopRequest),
    supervisorRunning: isProcessAlive(state?.supervisorPid),
    restarts: state?.restarts ?? 0,
    lastExit: state?.lastExit ?? null,
    lastProblem: state?.lastProblem ?? null,
    logFile: paths.logFile,
  };
  report(result, values.json, [
    result.installed ? `FLUJO instance "${name}" is set up (${result.entryName}, start mode ${result.mode ?? 'unknown'}).` : `FLUJO instance "${name}" is not set up on this system.`,
    ...(record ? [`Port ${record.port}, data in ${record.dataDir}, version ${result.version ?? 'unknown'}.`, `Answering: ${health}. Restarts since start: ${result.restarts}.`] : []),
    ...(result.stoppedOnPurpose ? ['It was stopped on purpose and will not start by itself. Use: flujo service start --name ' + name] : []),
  ]);
  return result.installed ? 0 : 3;
}

async function uninstall(values, { platform, root, name }) {
  const record = readServiceRecord(root);
  const paths = rootPaths(root);
  if (record) await stopInstance({ name, root, record, platform });
  const removed = platform === 'win32' ? removeWindowsTask(name) : removeSystemdUnit(name);
  for (const file of [paths.launcher, paths.service, paths.state, paths.lock, paths.stopRequest]) fs.rmSync(file, { force: true });
  if (values.purge) {
    // Refuse to remove anything that could hold the data directory.
    if (record && isSameOrInside(root, record.dataDir)) throw new CliError('The data directory is inside this folder, so --purge will not remove it.');
    fs.rmSync(root, { recursive: true, force: true });
  }
  report({ name, removed, purged: values.purge }, values.json, [
    removed ? `The autostart entry for "${name}" is removed.` : `There was no autostart entry for "${name}".`,
    record ? `The data directory was not touched: ${record.dataDir}` : '',
  ].filter(Boolean));
  return 0;
}

export async function main(argv, { platform = process.platform } = {}) {
  const [action, ...rest] = argv;
  let values;
  try { ({ values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false })); }
  catch { throw new CliError(USAGE); }
  if (values.help || !action || !['install', 'uninstall', 'status', 'start', 'stop', 'run'].includes(action)) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const name = validateServiceName(values.name);
  const root = resolveRoot(name, values.root);

  switch (action) {
    case 'install': return install(values, { platform, root, name });
    case 'status': return status(values, { platform, root, name });
    case 'uninstall': return uninstall(values, { platform, root, name });
    case 'start': {
      if (!readServiceRecord(root)) throw new CliError(`FLUJO instance "${name}" is not set up.`);
      const started = startInstance({ name, root, platform });
      report({ name, started }, values.json, [started ? `FLUJO instance "${name}" is starting.` : `FLUJO instance "${name}" could not be started.`]);
      return started ? 0 : 1;
    }
    case 'stop': {
      const record = readServiceRecord(root);
      if (!record) throw new CliError(`FLUJO instance "${name}" is not set up.`);
      const { forced } = await stopInstance({ name, root, record, platform });
      report({ name, stopped: true, forced }, values.json, [`FLUJO instance "${name}" is stopped and stays stopped until: flujo service start --name ${name}`]);
      return 0;
    }
    case 'run': {
      const dataDir = absoluteDirectory(values['data-dir'], '--data-dir');
      const port = validatePort(values.port);
      return runInstance({ name, dataDir, port, root });
    }
    default: return 1;
  }
}

/** Settings for the instance come from the .env file in its data directory. */
async function runInstance({ name, dataDir, port, root }) {
  const env = process.env;
  env.FLUJO_DATA_DIR = dataDir;
  env.FLUJO_PORT = String(port);
  env.FLUJO_SERVICE_NAME = name;
  env.FLUJO_SERVICE_ROOT_DIR = root;
  env.FLUJO_BOOTSTRAP_DIR ??= dataDir;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  loadBootstrapEnvironment(dataDir, false, nextEnv.loadEnvConfig, env);
  // The instance's named directory and port win over anything in its .env file.
  env.FLUJO_DATA_DIR = dataDir;
  env.FLUJO_PORT = String(port);
  // Each instance needs its own second port, or the second one would lose it.
  if (!env.FLUJO_MCP_APP_SANDBOX_PORT && port < 65535) env.FLUJO_MCP_APP_SANDBOX_PORT = String(port + 1);
  return runSupervisor({
    name, dataDir, port, root, env,
    instanceDirectory: localInstanceDirectory(env),
    program: path.join(packageRootOfThisFile, 'bin', 'flujo.mjs'),
  });
}
