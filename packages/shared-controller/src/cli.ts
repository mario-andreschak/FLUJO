import { configSchema } from './config.js';
import { readPrivateFile } from './private-storage.js';
import { Ledger } from './ledger.js';
import { lockController } from './process-lock.js';
import { createController } from './server.js';

export async function main(args: string[]): Promise<void> {
  const [action, filename, actorId] = args;
  if (!filename || !['serve', 'disable', 'enable', 'status'].includes(action)
      || (['disable', 'enable'].includes(action) ? !actorId || args.length !== 3 : args.length !== 2)) {
    throw new Error('Usage: flujo-controller <serve|status|disable|enable> /absolute/config.json [actor-id]');
  }
  // Protect SQLite sidecars as well as the original database.
  process.umask(0o077);
  const parsed = configSchema.safeParse(JSON.parse(readPrivateFile(filename).toString('utf8')));
  if (!parsed.success) throw new Error('Invalid controller configuration. Check the documented schema.');
  const config = parsed.data;
  const release = action === 'serve' ? lockController(config.stateDirectory) : undefined;
  let ledger: Ledger | undefined;
  try {
    ledger = new Ledger(config.stateDirectory);
    if (action === 'disable' || action === 'enable') {
      ledger.setActorEnabled(actorId, action === 'enable');
      process.stdout.write(`Actor ${action === 'enable' ? 'enabled' : 'disabled'}; existing browser sessions revoked.\n`);
    } else if (action === 'status') {
      const rows = ledger.db.prepare(`SELECT a.id AS actorId,a.enabled,r.id AS runtimeId,r.origin,r.enabled AS configured
        FROM actors a JOIN runtimes r ON r.actor_id=a.id ORDER BY a.id`).all();
      process.stdout.write(`${JSON.stringify({ actors: rows }, null, 2)}\n`);
    } else {
      const server = await createController(config, ledger);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
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
  } finally { ledger?.close(); release?.(); }
}
