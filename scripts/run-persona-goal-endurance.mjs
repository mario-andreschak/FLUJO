import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  enduranceAttestationKeySha256,
  writeEnduranceEvidenceAttestation,
} from './persona-goal-acceptance/endurance-attestation.mjs';
import { loadPublicFixtureManifest } from './persona-goal-acceptance/public-fixture-manifest.mjs';
import { startPublicFixtureServer } from './persona-goal-acceptance/public-fixture-server.mjs';
import { writeRuntimeProvenanceEvidence } from './persona-goal-acceptance/runtime-provenance.mjs';
import { validatePersonaGoalEndurance } from './validate-persona-goal-endurance.mjs';

const execute = promisify(execFile);
const options = new Map();
const allowed = new Set([
  'mode',
  'model',
  'profile',
  'duration-seconds',
  'active-seconds',
  'pause-seconds',
  'round-seconds',
  'round-limit',
  'max-model-calls',
  'budget-usd',
  'concurrency',
  'output',
  'fixture',
  'manifest',
  'run-id',
  'total-timeout-seconds',
  'confirm',
]);
for (const argument of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.+)$/.exec(argument);
  if (!match || !allowed.has(match[1]) || options.has(match[1])) {
    throw new Error('Unknown, duplicate or malformed argument: ' + argument + '. Use --name=value.');
  }
  options.set(match[1], match[2]);
}
if (options.get('confirm') !== 'controlled-effects') {
  throw new Error('Endurance execution is opt-in. Pass --confirm=controlled-effects after reviewing the manifest and budget.');
}
const mode = options.get('mode');
if (!['offline', 'live'].includes(mode)) {
  throw new Error('--mode=offline or --mode=live is required. Offline evidence never counts as live-model acceptance.');
}
const profile = options.get('profile') ?? 'structured-tools';
if (profile !== 'structured-tools') {
  throw new Error('Only --profile=structured-tools is currently executable. Terminal-only endurance fails closed until an OS-contained runner with an explicit network policy is available.');
}
if (mode === 'live' && typeof (await import('@openai/codex-sdk')).Codex !== 'function') {
  throw new Error('The genuine Codex SDK could not be loaded.');
}
if ((options.get('fixture') ?? 'controlled') !== 'controlled') {
  throw new Error('This implementation only authorizes the disposable controlled fixture. Genuine public services require a reviewed service-specific adapter and approval.');
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(options.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('--' + name + ' must be an integer from ' + minimum + ' through ' + maximum + '.');
  }
  return value;
}

const durationSeconds = boundedInteger('duration-seconds', 3600, 60, 2_419_200);
const pauseSeconds = boundedInteger('pause-seconds', 5, 1, 600);
const activeSeconds = boundedInteger(
  'active-seconds',
  Math.max(1, durationSeconds - pauseSeconds),
  1,
  durationSeconds,
);
const roundSeconds = boundedInteger('round-seconds', 10, 10, 3600);
const defaultRoundLimit = Math.min(10_000, Math.ceil(durationSeconds / roundSeconds) + 20);
const roundLimit = boundedInteger('round-limit', defaultRoundLimit, 6, 10_000);
const maxModelCalls = boundedInteger(
  'max-model-calls',
  Math.min(100_000, roundLimit * 16),
  1,
  100_000,
);
boundedInteger('concurrency', 1, 1, 1);
const totalTimeoutSeconds = boundedInteger(
  'total-timeout-seconds',
  durationSeconds + 600,
  durationSeconds + 300,
  Math.min(2_422_800, durationSeconds + 3_600),
);
const runnerStartedAt = Date.now();
const totalDeadline = runnerStartedAt + totalTimeoutSeconds * 1_000;
const cleanupReserveMs = 60_000;
const budgetUsd = Number(options.get('budget-usd') ?? (mode === 'live' ? 25 : 0));
if (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 10_000
  || (mode === 'live' && budgetUsd <= 0)) {
  throw new Error('--budget-usd must be positive for live mode and no greater than 10000.');
}
const manifest = await loadPublicFixtureManifest(options.get('manifest'));
if (manifest.serviceClass !== 'controlled-staging') {
  throw new Error('The controlled endurance runner cannot execute a genuine-public manifest.');
}

const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceHash = createHash('sha256').update(execFileSync(
  'git',
  ['-c', 'core.safecrlf=false', 'diff', '--binary', 'HEAD'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
));
const untracked = execFileSync(
  'git',
  ['ls-files', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
).trim().split('\n').filter(name =>
  /^(?:src|scripts|__tests__|docs|\.github)\//.test(name));
for (const name of untracked.sort()) {
  sourceHash.update(name).update(await fs.readFile(name));
}
const sourceDiffSha256 = sourceHash.digest('hex');
const requestedRunId = options.get('run-id');
if (requestedRunId && !/^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/.test(requestedRunId)) {
  throw new Error('--run-id must be 6-128 safe identifier characters.');
}
const runId = requestedRunId
  ?? mode + '-' + profile + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const outputDirectory = path.resolve(
  options.get('output') ?? path.join('goal-endurance-artifacts', runId),
);
await fs.mkdir(outputDirectory, { recursive: true });
if ((await fs.readdir(outputDirectory)).length) {
  throw new Error('Output directory must be empty so prior or failed evidence is never overwritten: ' + outputDirectory);
}
const verifierRoot = path.join(outputDirectory, 'trusted-verifier');
const agentRoot = path.join(outputDirectory, 'agent-workspace');
const runtimeData = path.join(outputDirectory, 'runtime-data');
await Promise.all([
  fs.mkdir(agentRoot, { recursive: true }),
  fs.mkdir(runtimeData, { recursive: true }),
]);
const token = randomBytes(32).toString('hex');
const { privateKey: attestationPrivateKey, publicKey: attestationPublicKey } = generateKeyPairSync('ed25519');
const attestationKeySha256 = enduranceAttestationKeySha256(attestationPublicKey);
const fixture = await startPublicFixtureServer({
  verifierRoot,
  agentRoot,
  runId,
  token,
  manifest,
});
const manifestSha256 = createHash('sha256')
  .update(await fs.readFile(path.join(verifierRoot, 'manifest.json')))
  .digest('hex');
const workspaceId = 'goal-endurance-' + runId;
const runnerStatePath = path.join(outputDirectory, 'runner-state.json');
let currentChild;
let interruptedSignal;
let completedPhases = [];

async function writeRunnerState(status, completedPhases, details = {}) {
  const state = {
    schemaVersion: 1,
    runId,
    status,
    completedPhases,
    updatedAt: new Date().toISOString(),
    commitSha,
    sourceDiffSha256,
    mode,
    profile,
    outputDirectory,
    ...details,
  };
  const temporary = runnerStatePath + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await fs.rename(temporary, runnerStatePath);
}

function jestArguments() {
  return [
    path.resolve('scripts/run-local-jest.cjs'),
    '--selectProjects',
    'node',
    '--runInBand',
    '--runTestsByPath',
    '--env=' + path.resolve('scripts/persona-goal-acceptance/endurance-jest-environment.cjs'),
    '__tests__/enduringAgents/goalEnduranceAcceptance.test.ts',
  ];
}

function remainingExecutionMs() {
  return Math.max(0, totalDeadline - cleanupReserveMs - Date.now());
}

function startPhase(phase) {
  const phaseBudgetMs = remainingExecutionMs();
  if (phaseBudgetMs < 30_000) {
    throw new Error('The whole-run deadline has no remaining execution budget for phase ' + phase + '.');
  }
  const child = spawn(process.execPath, jestArguments(), {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      FLUJO_DATA_DIR: runtimeData,
      FLUJO_FS_ROOTS: agentRoot,
      FLUJO_BASH_ROOTS: agentRoot,
      PERSONA_GOAL_ENDURANCE_PHASE: phase,
      PERSONA_GOAL_ENDURANCE_MODE: mode,
      PERSONA_GOAL_ENDURANCE_PROFILE: profile,
      PERSONA_GOAL_ENDURANCE_MODEL: options.get('model') ?? 'gpt-6-astra',
      PERSONA_GOAL_ENDURANCE_OUTPUT: outputDirectory,
      PERSONA_GOAL_ENDURANCE_AGENT_ROOT: agentRoot,
      PERSONA_GOAL_ENDURANCE_FIXTURE_URL: fixture.baseUrl,
      PERSONA_GOAL_ENDURANCE_FIXTURE_TOKEN: token,
      PERSONA_GOAL_ENDURANCE_IDEMPOTENCY_KEY: 'goal-endurance-publication:' + runId,
      PERSONA_GOAL_ENDURANCE_RUN_ID: runId,
      PERSONA_GOAL_ENDURANCE_WORKSPACE_ID: workspaceId,
      PERSONA_GOAL_ENDURANCE_COMMIT: commitSha,
      PERSONA_GOAL_ENDURANCE_DIFF_SHA256: sourceDiffSha256,
      PERSONA_GOAL_ENDURANCE_MANIFEST_ID: manifest.id,
      PERSONA_GOAL_ENDURANCE_MANIFEST_SHA256: manifestSha256,
      PERSONA_GOAL_ENDURANCE_DURATION_MS: String(durationSeconds * 1000),
      PERSONA_GOAL_ENDURANCE_ACTIVE_MS: String(activeSeconds * 1000),
      PERSONA_GOAL_ENDURANCE_PAUSE_MS: String(pauseSeconds * 1000),
      PERSONA_GOAL_ENDURANCE_ROUND_INTERVAL_MS: String(roundSeconds * 1000),
      PERSONA_GOAL_ENDURANCE_ROUND_LIMIT: String(roundLimit),
      PERSONA_GOAL_ENDURANCE_MAX_MODEL_CALLS: String(maxModelCalls),
      PERSONA_GOAL_ENDURANCE_BUDGET_USD: String(budgetUsd),
      PERSONA_GOAL_ENDURANCE_TOTAL_TIMEOUT_MS: String(totalTimeoutSeconds * 1_000),
      PERSONA_GOAL_ENDURANCE_PHASE_TIMEOUT_MS: String(phaseBudgetMs),
    },
  });
  currentChild = child;
  return child;
}

function observeExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function deadlineFailure(phase) {
  let timer;
  let cancelled = false;
  const promise = new Promise((_, reject) => {
    const arm = () => {
      if (cancelled) return;
      const remainingMs = remainingExecutionMs();
      if (remainingMs <= 0) {
        reject(new Error('Whole-run deadline expired during phase ' + phase + '.'));
        return;
      }
      timer = setTimeout(arm, Math.min(remainingMs, 60_000));
    };
    arm();
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

async function waitForExit(child, phase) {
  const exit = observeExit(child);
  const deadline = deadlineFailure(phase);
  try {
    return await Promise.race([exit, deadline.promise]);
  } catch (error) {
    await killProcessTree(child).catch(() => undefined);
    await exit.catch(() => undefined);
    throw error;
  } finally {
    deadline.cancel();
  }
}

async function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      .catch(() => child.kill('SIGKILL'));
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
}

async function listFilesRecursively(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursively(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

async function writeRuntimeModelTurnEvidence() {
  const checkpoints = await Promise.all([1, 2, 3].map(sequence =>
    fs.readFile(path.join(
      outputDirectory,
      'checkpoints',
      String(sequence).padStart(4, '0') + '.json',
    ), 'utf8').then(JSON.parse)));
  const epochs = checkpoints.map(checkpoint => checkpoint.processEpoch);
  const files = (await listFilesRecursively(runtimeData))
    .filter(filename => filename.endsWith('.json.gz')
      && filename.split(path.sep).includes('model-turns'));
  const records = [];
  for (const filename of files.sort()) {
    const compressed = await fs.readFile(filename);
    const snapshot = JSON.parse(gunzipSync(compressed).toString('utf8'));
    const turn = snapshot.entry;
    if (!turn?.id || !Number.isFinite(turn.timestamp)) continue;
    const epoch = epochs.find(candidate => turn.timestamp >= Date.parse(candidate.startedAt)
      && turn.timestamp <= Date.parse(candidate.endedAt));
    records.push({
      ...turn,
      source: 'runtime-model-turn-archive',
      sourceFileSha256: createHash('sha256').update(compressed).digest('hex'),
      processEpochId: epoch?.epochId,
      processPid: epoch?.pid,
    });
  }
  records.sort((left, right) =>
    left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  if (records.length === 0) {
    throw new Error('No runtime-owned model dispatch records were found.');
  }
  await fs.writeFile(
    path.join(outputDirectory, 'runtime-model-turns.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      collectedAt: new Date().toISOString(),
      sourceRoot: 'runtime-data/db/model-turns',
      records,
    }, null, 2) + '\n',
  );
}

async function runOrdinaryPhase(phase) {
  const child = startPhase(phase);
  const result = await waitForExit(child, phase);
  currentChild = undefined;
  if (result.code !== 0) {
    throw new Error('Endurance phase ' + phase + ' failed (code=' + result.code + ', signal=' + result.signal + ').');
  }
}

async function runCrashPhase() {
  const child = startPhase('crash-after-effect');
  const exit = observeExit(child);
  const marker = path.join(outputDirectory, 'checkpoints', '0002.json');
  const deadline = Date.now() + remainingExecutionMs();
  while (Date.now() < deadline) {
    try {
      await fs.access(marker);
      break;
    } catch {
      if (child.exitCode !== null || child.signalCode !== null) {
        const result = await exit;
        throw new Error('Crash phase exited before persisting its effect checkpoint (code=' + result.code + ').');
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  try {
    await fs.access(marker);
  } catch {
    throw new Error('Timed out waiting for the crash-after-effect checkpoint.');
  }
  await killProcessTree(child);
  const result = await exit;
  currentChild = undefined;
  if (result.code === 0 && !result.signal) {
    throw new Error('Crash phase exited cleanly; a real forced process boundary was not observed.');
  }
}

const onSignal = signal => {
  interruptedSignal = signal;
  if (currentChild) void killProcessTree(currentChild);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

process.stdout.write(
  'Persona goal endurance ' + runId + '\n'
  + 'Mode: ' + mode + '; profile: ' + profile + '; model: '
  + (options.get('model') ?? 'gpt-6-astra') + '; commit: ' + commitSha + '\n'
  + 'Observed duration: ' + durationSeconds + 's; active target: ' + activeSeconds
  + 's; round limit: ' + roundLimit + '; model-call limit: ' + maxModelCalls
  + '; budget: $' + budgetUsd + '; whole-run timeout: ' + totalTimeoutSeconds + 's\n'
  + 'Evidence: ' + outputDirectory + '\n',
);

try {
  await writeRunnerState('running', []);
  await runOrdinaryPhase('bootstrap');
  completedPhases = ['bootstrap'];
  await writeRunnerState('running', completedPhases);
  await runCrashPhase();
  completedPhases = ['bootstrap', 'crash-after-effect'];
  await writeRunnerState('running', completedPhases);
  await runOrdinaryPhase('recover');
  completedPhases = ['bootstrap', 'crash-after-effect', 'recover'];
  await writeRuntimeModelTurnEvidence();
  await writeRuntimeProvenanceEvidence({
    runtimeData,
    reportPath: path.join(outputDirectory, 'persona-goal-endurance.json'),
    outputPath: path.join(outputDirectory, 'runtime-provenance.json'),
    runId,
  });
  await writeRunnerState('attesting', completedPhases, { attestationKeySha256 });
  await writeEnduranceEvidenceAttestation({
    directory: outputDirectory,
    privateKey: attestationPrivateKey,
    publicKey: attestationPublicKey,
    runId,
    commitSha,
    sourceDiffSha256,
  });
  await writeRunnerState('validating', completedPhases, { attestationKeySha256 });
  await validatePersonaGoalEndurance({
    directory: outputDirectory,
    expectedCommit: commitSha,
    expectedMode: mode,
    expectedProfile: profile,
    expectedSourceDiffSha256: sourceDiffSha256,
    expectedAttestationKeySha256: attestationKeySha256,
  });
  await writeRunnerState('completed', completedPhases, { attestationKeySha256 });
  process.stdout.write('Validated endurance evidence: '
    + path.join(outputDirectory, 'persona-goal-endurance.json') + '\n'
    + 'Attestation key SHA-256: ' + attestationKeySha256 + '\n');
} catch (error) {
  process.exitCode = 1;
  await fixture.cleanup().catch(() => undefined);
  await writeRunnerState('incomplete', completedPhases, {
    signal: interruptedSignal,
    failure: error instanceof Error ? error.stack ?? error.message : String(error),
  }).catch(() => undefined);
  process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
} finally {
  if (currentChild) await killProcessTree(currentChild).catch(() => undefined);
  await fixture.close().catch(() => undefined);
}
