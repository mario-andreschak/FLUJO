import { configSchema, runtimeRevision } from './config.js';
import { readPrivateFile } from './private-storage.js';
import { Ledger } from './ledger.js';
import { ControllerBusyError, lockController } from './process-lock.js';
import { createController, type ControllerServer } from './server.js';
import { promptPassword } from './password-prompt.js';
import { LocalEngine } from './local-engine.js';
import { LocalRuntimeDriver } from './local-runtime.js';
import { RuntimeSupervisor } from './runtime-supervisor.js';
import { RuntimePipes } from './runtime-pipes.js';
import type { RuntimeIntent } from './local-runtime-policy.js';
import { provisionRuntime } from './provision-runtime.js';
import { rotateRuntime } from './rotate-runtime.js';
import { setupController } from './setup.js';
import { ensureLocalTLS } from './local-tls.js';
import { updateLocalTrust } from './tls-trust.js';
import { ModelBrokers } from './model-brokers.js';

const runtimeStatus = (intent: RuntimeIntent) => ({ runtimeId: intent.runtimeId, actorId: intent.actorId,
  desired: intent.desired, phase: intent.phase, generation: intent.generation,
  verifiedAt: intent.verifiedAt, problem: intent.problem });

export async function main(args: string[]): Promise<void> {
  const [action, filename, actorId] = args;
  // Protect SQLite sidecars as well as the original database.
  process.umask(0o077);
  if (action === 'setup') {
    if (args.length !== 4) throw new Error('Usage: flujo-controller setup /absolute/new-directory actor-id sha256:image-id');
    const created = setupController(filename, actorId, args[3]);
    process.stdout.write(`${JSON.stringify({ ...created,
      next: 'Run tls-init and tls-trust, then provision this owner, initialize the ledger and enroll its password before serving.' }, null, 2)}\n`);
    return;
  }
  if (!filename || !['init', 'serve', 'disable', 'enable', 'status', 'password', 'reconcile', 'provision',
    'tls-init', 'tls-renew', 'tls-trust', 'tls-untrust', 'rotate', 'resume-rotation', 'disable-model', 'enable-model'].includes(action)
      || (['disable-model', 'enable-model'].includes(action) ? !actorId || !args[3] || args.length !== 4
        : ['disable', 'enable', 'password', 'provision', 'rotate', 'resume-rotation'].includes(action) ? !actorId || args.length !== 3
        : ['tls-trust', 'tls-untrust'].includes(action) ? args.length < 2 || args.length > 3 : args.length !== 2)) {
    throw new Error('Invalid local controller command. Use --help for arguments.');
  }
  const parsed = configSchema.safeParse(JSON.parse(readPrivateFile(filename).toString('utf8')));
  if (!parsed.success) throw new Error('Invalid controller configuration. Check the documented schema.');
  const config = parsed.data;
  if (action === 'tls-trust' || action === 'tls-untrust') {
    const target = await updateLocalTrust(config, action === 'tls-untrust', actorId);
    process.stdout.write(`${JSON.stringify({ target, trusted: action === 'tls-trust' })}\n`);
    return;
  }
  if (action === 'tls-init' || action === 'tls-renew') {
    const unlock = lockController(config.stateDirectory);
    try {
      const material = await ensureLocalTLS(config, { initialize: action === 'tls-init', renew: action === 'tls-renew' });
      process.stdout.write(`${JSON.stringify({ caFile: material.caFile, rootFingerprint: material.rootFingerprint,
        expiresAt: new Date(material.expiresAt).toISOString(), next: 'Trust this public CA locally before browser access. Private keys must remain here.' }, null, 2)}\n`);
    } finally { unlock(); }
    return;
  }
  let release = ['serve', 'init', 'reconcile', 'provision', 'rotate', 'resume-rotation'].includes(action) ? lockController(config.stateDirectory) : undefined;
  let ledger: Ledger | undefined;
  let supervisor: RuntimeSupervisor | undefined;
  let pipes: RuntimePipes | undefined;
  let models: ModelBrokers | undefined;
  let controller: ControllerServer | undefined;
  try {
    ledger = new Ledger(config.stateDirectory);
    if (action === 'disable-model' || action === 'enable-model') {
      ledger.setModelEnabled(actorId, args[3], action === 'enable-model');
      process.stdout.write(`${JSON.stringify({ actorId, grantId: args[3], accessRequested: action === 'enable-model',
        note: 'Grant changes are durable. The running relay rechecks active requests each second; disconnect does not prove upstream inference stopped.' })}\n`);
    } else if (action === 'rotate' || action === 'resume-rotation') {
      const result = await rotateRuntime(filename, config, ledger, actorId, action === 'resume-rotation');
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.verified) process.exitCode = 2;
    } else if (action === 'provision') {
      const runtime = await provisionRuntime(filename, config, ledger, actorId);
      process.stdout.write(`${JSON.stringify({ runtimeId: runtime.id, actorId: runtime.actorId, origin: runtime.origin,
        containerId: runtime.localRuntime?.containerId, next: 'Initialize the local ledger and enroll the account password before serving.' }, null, 2)}\n`);
    } else if (action === 'init') {
      ledger.reconcile(config);
      process.stdout.write('Local accounts configured. Set each account password before signing in.\n');
    } else if (action === 'password') {
      const runtime = config.runtimes.find(candidate => candidate.actorId === actorId);
      if (!runtime) throw new Error('Unknown configured actor.');
      let password = await promptPassword();
      await ledger.setPassword(runtime, runtimeRevision(config, runtime), password);
      password = '';
      process.stdout.write('Local password updated; existing sessions revoked. Account enablement is unchanged.\n');
    } else if (action === 'disable' || action === 'enable') {
      ledger.setActorEnabled(actorId, action === 'enable');
      const intent = ledger.intents().find(item => item.actorId === actorId);
      if (!intent) {
        process.stdout.write('Browser access updated; runtime execution is unmanaged and must be controlled locally.\n');
        process.exitCode = 2;
      } else {
        try { release = lockController(config.stateDirectory); }
        catch (error) { if (!(error instanceof ControllerBusyError)) throw error; }
        if (release) {
          supervisor = new RuntimeSupervisor(ledger, new LocalRuntimeDriver(new LocalEngine(config.stateDirectory)));
          await supervisor.reconcile(actorId);
        } else {
          // The live controller is the sole lifecycle writer. Observe this exact
          // intent; do not race it with a second Docker start/stop command.
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const current = ledger.intents().find(item => item.runtimeId === intent.runtimeId);
            if (!current || current.generation !== intent.generation || current.phase !== 'pending') break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        const current = ledger.intents().find(item => item.runtimeId === intent.runtimeId);
        process.stdout.write(`${JSON.stringify(current ? runtimeStatus(current) : { phase: 'unknown' }, null, 2)}\n`);
        if (!current || current.generation !== intent.generation || current.phase !== 'confirmed') process.exitCode = 2;
      }
    } else if (action === 'status') {
      const rows = ledger.db.prepare(`SELECT a.id AS actorId,a.enabled AS accessRequested,r.id AS runtimeId,r.origin,r.enabled AS configured,
        (p.actor_id IS NOT NULL) AS passwordConfigured
        FROM actors a JOIN runtimes r ON r.actor_id=a.id LEFT JOIN passwords p ON p.actor_id=a.id ORDER BY a.id`).all();
      const provisioning = ledger.db.prepare('SELECT runtime_id AS runtimeId,phase FROM runtime_provisioning ORDER BY runtime_id').all();
      const rotations = ledger.db.prepare('SELECT id AS operationId,runtime_id AS runtimeId,phase,created_at AS createdAt FROM runtime_rotations ORDER BY created_at').all();
      const modelGrants = ledger.db.prepare('SELECT runtime_id AS runtimeId,id AS grantId,enabled AS accessRequested,configured,generation FROM runtime_model_grants ORDER BY runtime_id,id').all();
      process.stdout.write(`${JSON.stringify({ actors: rows, runtimes: ledger.intents().map(runtimeStatus), provisioning, rotations, modelGrants }, null, 2)}\n`);
    } else if (action === 'reconcile') {
      ledger.reconcile(config);
      supervisor = new RuntimeSupervisor(ledger, new LocalRuntimeDriver(new LocalEngine(config.stateDirectory)));
      await supervisor.reconcile();
      const runtimes = ledger.intents().map(runtimeStatus);
      process.stdout.write(`${JSON.stringify({ runtimes }, null, 2)}\n`);
      if (runtimes.some(intent => intent.phase !== 'confirmed')) process.exitCode = 2;
    } else {
      const server = await createController(config, ledger, runtime => pipes?.connect(runtime));
      controller = server;
      if (ledger.intents().length) {
        const engine = new LocalEngine(config.stateDirectory);
        supervisor = new RuntimeSupervisor(ledger, new LocalRuntimeDriver(engine));
        pipes = new RuntimePipes(config, ledger, engine);
        models = new ModelBrokers(config, ledger, engine);
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      supervisor?.start();
      models?.start();
      process.stdout.write(`FLUJO controller listening on 127.0.0.1:${config.port}. ${config.tls ? 'Local HTTPS enabled.' : 'TLS proxy required for this legacy configuration.'}\n`);
      for (const runtime of config.runtimes) process.stdout.write(`Open ${runtime.origin}/_account\n`);
      await new Promise<void>((resolve, reject) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          server.close(() => resolve());
          server.closeAllConnections();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        server.once('error', reject);
        server.once('close', () => {
          process.off('SIGINT', stop); process.off('SIGTERM', stop);
        });
      });
    }
  } finally {
    try {
      try { await supervisor?.stop(); }
      finally { try { await models?.close(); } finally { try { await pipes?.close(); } finally { await controller?.stopTLS(); } } }
    }
    finally { ledger?.close(); release?.(); }
  }
}
