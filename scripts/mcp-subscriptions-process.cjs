// Read-only IPC observation of the isolated acceptance workspace. No HTTP test route.
const path = require('node:path');
const { createRequire } = require('node:module');
const requireApplication = createRequire(path.join(process.cwd(), 'package.json'));
const { startServer } = requireApplication('next/dist/server/lib/start-server');
process.on('message', message => {
  if (message === 'stop') process.emit('SIGTERM', 'SIGTERM');
  if (message?.type !== 'subscription-state' || message.workspace !== 'subscription-acceptance') return;
  const registries = global.__mcp_workspace_registries?.get(message.workspace);
  const names = ['events-legacy', 'events-modern'];
  process.send?.({ type: 'subscription-state', requestId: message.requestId, servers: names.map(name => ({
    name, connected: registries?.get('clients')?.has(name) ?? false,
    pendingUris: [...(registries?.get('pendingResourceUpdates')?.get(name) ?? [])],
  })) });
});
startServer({ dir: process.cwd(), isDev: false, hostname: '127.0.0.1', port: Number(process.argv[2]), allowRetry: false })
  .then(() => process.send?.({ type: 'journey-server-ready', pid: process.pid }))
  .catch(error => { process.stderr.write(String(error)); process.exit(1); });
