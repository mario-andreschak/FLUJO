'use strict';
// Source-loaded application witness. No readiness setters, scheduler/engine
// mocks, forced clock, runNow, or synthetic occurrence admission.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = process.cwd();
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
  if (request === 'mcp-stdio-oauth/client' || request === 'mcp-stdio-oauth/protocol') {
    request = path.join(root, 'node_modules/mcp-stdio-oauth/dist', request.split('/')[1], 'index.js');
  }
  if (request === 'mcp-stdio-oauth/client/transport') {
    request = path.join(root, 'node_modules/mcp-stdio-oauth/dist/client/transport.js');
  }
  if (request.startsWith('.') && request.endsWith('.js') && parent) {
    const source = path.resolve(path.dirname(parent.filename), request.slice(0, -3) + '.ts');
    if (fs.existsSync(source)) request = source;
  }
  return resolve.call(this, request, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(
  fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
const source = name => require(path.join(root, 'src', name));
const send = message => { if (process.connected) process.send(message); };
const sendFlushed = message => new Promise((resolve, reject) => {
  if (!process.connected) { resolve(); return; }
  process.send(message, error => error ? reject(error) : resolve());
});
const startedAt = Date.now();
let diagnosticCount = 0;
function phase(code) {
  if (diagnosticCount >= 128) return; // Preserve the real operation when the diagnostic budget is exhausted.
  diagnosticCount++;
  send({ phase: 'diagnostic', code, elapsedMs: Date.now() - startedAt });
}
let owner;
let scheduler;
let stopping = false;
let backendEntered = false;
let pendingApprovedConfigs;
const captures = new (require('./ownedCaptureLedger.cjs').OwnedCaptureLedger)();
const directories = require('./ownedDirectory.cjs');
let commands = Promise.resolve();

async function shutdown() {
  stopping = true;
  const failures = [];
  phase('scheduler-stop-enter');
  try { if (scheduler) await scheduler.stopWorker(); phase('scheduler-stop-ready'); }
  catch (error) { failures.push(error); }
  try { await captures.drain(); } catch (error) { failures.push(error); }
  if (pendingApprovedConfigs) {
    try {
      if (!(await source('backend/services/mcp/config.ts').saveConfig(new Map(
        pendingApprovedConfigs.map(config => [config.name, config])))).success) {
        throw new Error('Exact approved equipment configuration remains unrestored');
      }
      pendingApprovedConfigs = undefined;
    } catch (error) { failures.push(error); }
  }
  // Do not import/start the backend graph to clean up a seed-only failure.
  phase('backend-shutdown-enter');
  try { if (backendEntered) await source('backend/init.ts').shutdownBackendServices('owned worker bootstrap fixture'); phase('backend-shutdown-ready'); }
  catch (error) { failures.push(error); }
  // Private owner cleanup is independent of backend shutdown success.
  if (owner) {
    phase('owner-cleanup-enter');
    try { owner.restore(); owner = undefined; phase('owner-cleanup-ready'); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) {
    stopping = false; // Disconnect may retry actual cleanup; an ACK is withheld.
    send({ phase: 'cleanup-failed', error: failures.map(error => String(error.stack || error)).join('\n') });
    throw new AggregateError(failures, 'Worker fixture shutdown/owner cleanup failed');
  }
  await sendFlushed({ phase: 'cleanup-completed' });
}

async function exitSeedOnly(code) {
  if (backendEntered || owner) throw new Error('Seed-only exit cannot retire a live backend/owner');
  // Seed preparation never connects MCP or executes its effect program. Drain
  // owned output before exiting; the parent still observes exit and close.
  await Promise.all([new Promise(resolve => process.stdout.end(resolve)),
    new Promise(resolve => process.stderr.end(resolve))]);
  if (process.connected) process.disconnect();
  process.exit(code);
}

async function command(message) {
  if (!message || typeof message.id !== 'string') throw new Error('Missing command identity');
  let result;
  switch (message.action) {
    case 'list': result = await scheduler.list(); break;
    case 'create': {
      // A real persisted Flow is required. The parent cannot submit executable
      // code through this protocol; it chooses a flow captured in its snapshot.
      const flow = await source('backend/services/flow/index.ts').flowService.getFlow(message.flowId);
      if (!flow) throw new Error('Snapshot flow is unavailable');
      const created = await scheduler.create({ id: message.planId, name: 'Owned bootstrap recovery',
        enabled: true, startRestriction: 'singleton', flowId: message.flowId,
        prompt: 'Owned offline effect fixture', overlapStrategy: 'skip',
        trigger: { type: 'schedule', cron: '* * * * *', catchUp: true }, saveConversations: false });
      if (!created.execution || created.error) throw new Error(created.error || 'Creation failed');
      const recovery = source('backend/services/scheduler/workerLocalRecovery.ts');
      await scheduler.setWorkerLocalRecovery(created.execution.id, { enabled: true,
        expectedGenerationId: created.execution.generationId,
        expectedDefinitionSha256: recovery.workerRecoveryDefinitionSha256(created.execution) });
      result = created.execution;
      break;
    }
    case 'pause': await scheduler.setPaused(message.paused === true); result = await scheduler.list(); break;
    case 'disable': result = await scheduler.update(message.planId, { enabled: false }); break;
    case 'withdraw': {
      const execution = await scheduler.get(message.planId);
      if (!execution) throw new Error('Missing enrolled execution');
      await scheduler.setWorkerLocalRecovery(execution.id, { enabled: false,
        expectedGenerationId: execution.generationId,
        expectedDefinitionSha256: source('backend/services/scheduler/workerLocalRecovery.ts')
          .workerRecoveryDefinitionSha256(execution) });
      result = await scheduler.list();
      break;
    }
    case 'export': {
      phase('portable-export-enter');
      // Export a portable operator configuration, not this machine's host-home
      // environment/attestation. Stop actual timers before temporary storage
      // projection; restore the exact approved configuration independently.
      await scheduler.stopWorker();
      const configuration = source('backend/services/mcp/config.ts');
      const configs = await configuration.loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error('Unavailable export configuration');
      const shipped = source('backend/services/mcp/shippedServers.ts');
      const descriptor = shipped.SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'bash');
      const effectRoot = path.join(source('utils/workspace.ts').getWorkspaceDataDir(), 'userdata', 'worker-bootstrap');
      const portable = { ...shipped.createShippedServerConfig(descriptor, {}), name: 'bash', disabled: false,
        roots: [effectRoot], env: { FLUJO_BASH_ROOTS: effectRoot, FLUJO_FS_ROOTS: effectRoot } };
      pendingApprovedConfigs = configs;
      const failures = [];
      let captured;
      try {
      if (!(await configuration.saveConfig(new Map(configs.map(config => [config.name,
        config.name === 'bash' ? portable : config])))).success) throw new Error('Portable export projection failed');
      const key = require('node:crypto').randomBytes(32).toString('base64');
      const archive = source('backend/services/workspace/snapshotArchive.ts');
      captured = captures.own(await archive.captureWorkspaceSnapshot(
        source('utils/workspace.ts').getCurrentWorkspace(), 2, { recipientKey: key }));
        const written = await archive.writeWorkspaceSnapshotArchive(captured);
        const staging = await directories.captureOwnedDirectory(written.stagingDir);
        result = { archivePath: written.archivePath, stagingDir: written.stagingDir,
          stagingIdentity: directories.describeOwnedDirectory(staging), sha256: written.sha256, key };
      } catch (error) { failures.push(error); }
      finally {
        try { if (captured) await captures.dispose(captured); }
        catch (error) { failures.push(error); send({ phase: 'cleanup-failed', error: String(error.stack || error) }); }
        try {
          if (!(await configuration.saveConfig(new Map(configs.map(config => [config.name, config])))).success) {
            throw new Error('Exact approved configuration restoration failed');
          }
          pendingApprovedConfigs = undefined;
        } catch (error) {
          failures.push(error); send({ phase: 'cleanup-failed', error: String(error.stack || error) });
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Export and independent owned cleanup failed');
      phase('portable-export-ready');
      break;
    }
    case 'start-again': await scheduler.start(); result = await scheduler.list(); break;
    case 'stop': await shutdown(); send({ id: message.id, result: { shutdownCompleted: true } });
      // The parent must separately observe OS exit/close; this reply is an ACK.
      process.disconnect(); return;
    default: throw new Error('Unsupported fixture command');
  }
  send({ id: message.id, result });
}

const bootstrap = (async () => {
  if (process.argv[2] === 'seed') {
    await source('backend/services/workspace/migration.ts').migrateWorkspaceLayout();
    const secure = source('utils/encryption/secure.ts');
    const password = 'disposable-owned-worker-bootstrap-fixture';
    if (!await secure.initializeEncryption(password) || !await secure.authenticate(password)) {
      throw new Error('Owned seed encryption failed');
    }
    // Effect equipment must travel with userdata, not reference parent Temp.
    const scratch = path.join(source('utils/workspace.ts').getWorkspaceDataDir(), 'userdata', 'worker-bootstrap');
    fs.mkdirSync(scratch, { recursive: true });
    const program = path.join(scratch, 'effect.cjs');
    const journal = path.join(scratch, 'effects.ndjson');
    fs.writeFileSync(program, "require('node:fs').appendFileSync(require('node:path').join(__dirname,'effects.ndjson'),JSON.stringify({pid:process.pid,at:Date.now()})+'\\n');console.log('owned effect completed');");
    await source('backend/services/mcp/shippedWorkspacePackages.ts').ensureShippedWorkspacePackages(
      source('utils/workspace.ts').getWorkspaceDataDir(), undefined, ['bash']);
    const shipped = source('backend/services/mcp/shippedServers.ts');
    const descriptor = shipped.SHIPPED_MCP_SERVERS.find(item => item.packageDirectory === 'bash');
    const config = { ...shipped.createShippedServerConfig(descriptor, {}), name: 'bash', disabled: false,
      roots: [scratch], env: { FLUJO_BASH_ROOTS: scratch, FLUJO_FS_ROOTS: scratch } };
    if (!(await source('backend/services/mcp/config.ts').saveConfig(new Map([['bash', config]]))).success) {
      throw new Error('Seed MCP config failed');
    }
    const quote = value => process.platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'"
      : "'" + value.replace(/'/g, "'\\''") + "'";
    const command = (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote('effect.cjs');
    const compiled = source('utils/shared/flowSpecCompiler.ts').compileFlowSpec({
      name: 'Owned real bootstrap effect', nodes: [{ key: 'start', type: 'start' },
        { key: 'effect', type: 'static', entries: [{ kind: 'toolCall', executionMode: 'real',
          serverName: 'bash', toolName: 'run', argumentsJson: JSON.stringify({ command, cwd: 'userdata/worker-bootstrap', timeout: 10 }),
          result: '', captureVariable: 'effect', resultFormat: 'text', onError: 'fail' }] },
        { key: 'finish', type: 'finish' }],
      edges: [{ from: 'start', to: 'effect' }, { from: 'effect', to: 'finish' }],
    }, { servers: [{ name: 'bash' }], serverTools: { bash: ['run'] } });
    if (!compiled.flow || compiled.errorCount) throw new Error('Seed flow compilation failed');
    if (!(await source('backend/services/flow/index.ts').flowService.saveFlow(compiled.flow)).success) {
      throw new Error('Seed flow persistence failed');
    }
    const at = new Date().toISOString();
    await source('utils/storage/backend.ts').saveItem('planned_executions', { version: 1, paused: false,
      executions: [{ id: 'copied-plan', generationId: 'copied-generation', createdAt: at, updatedAt: at,
        name: 'Copied plan must stay inert', enabled: true, flowId: compiled.flow.id,
        prompt: 'Copied fixture', overlapStrategy: 'skip', startRestriction: 'singleton',
        trigger: { type: 'schedule', cron: '* * * * *', catchUp: true }, saveConversations: false }] });
    const key = require('node:crypto').randomBytes(32).toString('base64');
    const archive = source('backend/services/workspace/snapshotArchive.ts');
    const workspace = source('utils/workspace.ts').getCurrentWorkspace();
    const captured = captures.own(await archive.captureWorkspaceSnapshot(workspace, 1, { recipientKey: key }));
    let written;
    const failures = [];
    try { written = await archive.writeWorkspaceSnapshotArchive(captured); }
    catch (error) { failures.push(error); }
    try { await captures.dispose(captured); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Seed export and owned capture cleanup failed');
    const staging = await directories.captureOwnedDirectory(written.stagingDir);
    await sendFlushed({ phase: 'seeded', archivePath: written.archivePath, stagingDir: written.stagingDir,
      stagingIdentity: directories.describeOwnedDirectory(staging),
      sha256: written.sha256, key, workspace, flowId: compiled.flow.id, journal });
    await sendFlushed({ phase: 'cleanup-completed' }); // Captured owned descriptors were disposed above; no worker was started.
    stopping = true;
    await exitSeedOnly(0);
    return;
  }
  if (process.env.FLUJO_WORKER_MODE !== '1' || !process.env.FLUJO_WORKER_SNAPSHOT) {
    throw new Error('A genuine worker snapshot and worker mode are required');
  }
  // Restore/unlock first so the owner reviews the actual restored proposal.
  // ensureBackendInitialized subsequently traverses the real startup graph.
  const restore = source('backend/services/workspace/snapshotRestore.ts');
  phase('restore-unlock-enter');
  const snapshot = await restore.restoreConfiguredWorkerSnapshot();
  if (!snapshot) throw new Error('Snapshot restore returned no worker');
  await restore.unlockWorkerSnapshot(snapshot);
  phase('restore-unlock-ready');
  // Bundled MCP checkouts are deliberately omitted from snapshots. Materialize
  // the actual local distribution before asking the owner to review its files.
  const workspaceRoot = source('utils/workspace.ts').getWorkspaceDataDir();
  phase('bundled-equipment-enter');
  await source('backend/services/mcp/shippedWorkspacePackages.ts').ensureShippedWorkspacePackages(
    workspaceRoot, undefined, ['bash']);
  const shipped = source('backend/services/mcp/shippedServers.ts');
  const configs = await source('backend/services/mcp/config.ts').loadServerConfigs();
  if (!Array.isArray(configs)) throw new Error('Restored MCP configuration unavailable');
  const bash = configs.find(config => config.name === 'bash');
  const descriptor = bash && shipped.shippedDescriptorForConfig(bash);
  if (!descriptor || descriptor.packageDirectory !== 'bash' || bash.transport !== 'stdio' || bash.disabled) {
    throw new Error('Restored snapshot does not contain the expected enabled bundled Bash');
  }
  const effectRoot = path.join(workspaceRoot, 'userdata', 'worker-bootstrap');
  const runtime = { ...shipped.createShippedServerConfig(descriptor, {}), name: 'bash', disabled: false,
    roots: [effectRoot], env: { FLUJO_BASH_ROOTS: effectRoot, FLUJO_FS_ROOTS: effectRoot } };
  if (!(await source('backend/services/mcp/config.ts').saveConfig(new Map(
    configs.map(config => [config.name, config.name === 'bash' ? runtime : config])))).success) {
    throw new Error('Owned restored Bash equipment configuration failed');
  }
  phase('bundled-equipment-ready');
  owner = require(path.join(root, '__tests__/mcp/fixtures/bundledFixtureOwner.ts')).installBundledFixtureOwner();
  const consent = source('backend/services/security/bundledMcpConsent.ts');
  phase('owner-preview-enter');
  const reviewed = await consent.previewBundledHostConsent('bash', { runtimeHome: 'host' });
  phase('owner-preview-ready');
  phase('owner-approval-enter');
  await consent.approveBundledHostConsent(owner.request('bash'), 'bash', {
    runtimeHome: 'host', reviewedDigest: reviewed.policyDigest, expiresAt: owner.expiresAt,
  });
  phase('owner-approval-ready');
  backendEntered = true;
  phase('backend-bootstrap-enter');
  await source('backend/init.ts').ensureBackendInitialized();
  phase('backend-bootstrap-ready');
  const status = source('backend/services/workspace/workerMode.ts').getWorkerBootstrapStatus();
  if (status.state !== 'ready') throw new Error(`Actual bootstrap failed: ${status.state}`);
  scheduler = source('backend/services/scheduler/index.ts').getSchedulerService();
  process.on('message', message => {
    commands = commands.then(() => command(message)).catch(error => {
      send({ id: message && message.id, error: String(error.stack || error) });
    });
  });
  send({ phase: 'bootstrapped', status, plans: await scheduler.list(),
    workspaceDataDir: source('utils/workspace.ts').getWorkspaceDataDir(),
    journal: path.join(source('utils/workspace.ts').getWorkspaceDataDir(), 'userdata', 'worker-bootstrap', 'effects.ndjson') });
})().catch(async error => {
  await sendFlushed({ phase: 'failed', error: String(error.stack || error) });
  let cleaned = false;
  try { await shutdown(); cleaned = true; } catch (cleanup) { send({ phase: 'cleanup-failed', error: String(cleanup) }); }
  process.exitCode = 1;
  if (cleaned && !backendEntered) { await exitSeedOnly(1); return; }
  if (process.connected) process.disconnect();
});
process.on('disconnect', () => {
  if (!stopping) {
    stopping = true;
    // A disconnected parent cannot certify cleanup while the actual bootstrap
    // or an owned command can still create captures or prepare backend effects.
    void bootstrap.then(() => commands).then(shutdown).catch(error => {
      process.stderr.write(String(error)); process.exitCode = 1;
    });
  }
});
