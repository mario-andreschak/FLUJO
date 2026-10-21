import { configSchema, runtimeRevision } from './config.js';
import { readPrivateFile } from './private-storage.js';
import { Ledger } from './ledger.js';
import { ControllerBusyError, lockController } from './process-lock.js';
import { createController } from './server.js';
import { promptPassword } from './password-prompt.js';
import { LocalEngine } from './local-engine.js';
import { LocalRuntimeDriver } from './local-runtime.js';
import { RuntimeSupervisor } from './runtime-supervisor.js';
import { RuntimePipes } from './runtime-pipes.js';
import type { RuntimeIntent } from './local-runtime-policy.js';
import { provisionRuntime } from './provision-runtime.js';

const runtimeStatus = (intent: RuntimeIntent) => ({ runtimeId: intent.runtimeId, actorId: intent.actorId,
  desired: intent.desired, phase: intent.phase, generation: intent.generation,
  verifiedAt: intent.verifiedAt, problem: intent.problem });

export async function main(args: string[]): Promise<void> {
  const [action, filename, actorId] = args;
  if (!filename || !['init', 'serve', 'disable', 'enable', 'status', 'password', 'reconcile', 'provision'].includes(action)
      || (['disable', 'enable', 'password', 'provision'].includes(action) ? !actorId || args.length !== 3 : args.length !== 2)) {
    throw new Error('Usage: flujo-controller <provision|init|serve|status|disable|enable|password|reconcile> /absolute/config.json [actor-id]');
  }
  // Protect SQLite sidecars as well as the original database.
  process.umask(0o077);
  const parsed = configSchema.safeParse(JSON.parse(readPrivateFile(filename).toString('utf8')));
  if (!parsed.success) throw new Error('Invalid controller configuration. Check the documented schema.');
  const config = parsed.data;
  let release = ['serve', 'init', 'reconcile', 'provision'].includes(action) ? lockController(config.stateDirectory) : undefined;
  let ledger: Ledger | undefined;
  let supervisor: RuntimeSupervisor | undefined;
  let pipes: RuntimePipes | undefined;
  try {
    ledger = new Ledger(config.stateDirectory);
    if (action === 'provision') {
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
      process.stdout.write(`${JSON.stringify({ actors: rows, runtimes: ledger.intents().map(runtimeStatus), provisioning }, null, 2)}\n`);
    } else if (action === 'reconcile') {
      ledger.reconcile(config);
      supervisor = new RuntimeSupervisor(ledger, new LocalRuntimeDriver(new LocalEngine(config.stateDirectory)));
      await supervisor.reconcile();
      const runtimes = ledger.intents().map(runtimeStatus);
      process.stdout.write(`${JSON.stringify({ runtimes }, null, 2)}\n`);
      if (runtimes.some(intent => intent.phase !== 'confirmed')) process.exitCode = 2;
    } else {
      const server = await createController(config, ledger, runtime => pipes?.path(runtime));
      if (ledger.intents().length) {
        const engine = new LocalEngine(config.stateDirectory);
        supervisor = new RuntimeSupervisor(ledger, new LocalRuntimeDriver(engine));
        pipes = new RuntimePipes(config, ledger, engine);
        await pipes.open();
      }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      supervisor?.start();
      process.stdout.write(`FLUJO controller listening on 127.0.0.1:${config.port}. TLS proxy required.\n`);
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
    await supervisor?.stop();
    await pipes?.close();
    ledger?.close(); release?.();
  }
}
