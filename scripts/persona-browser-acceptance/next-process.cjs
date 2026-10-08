// Keep the Next CLI's production server and signal cleanup; IPC lets Windows
// request the same graceful shutdown instead of TerminateProcess/taskkill.
const path = require('node:path');
const { createRequire } = require('node:module');
const requireApplication = createRequire(path.join(process.cwd(), 'package.json'));
const { startServer } = requireApplication('next/dist/server/lib/start-server');
process.on('message', message => {
  if (message === 'stop') process.emit('SIGTERM', 'SIGTERM');
});
startServer({ dir: process.cwd(), isDev: false, hostname: '127.0.0.1', port: Number(process.argv[2]), allowRetry: false })
  .then(() => process.send?.({ type: 'journey-server-ready', pid: process.pid }))
  .catch(error => { process.stderr.write(String(error)); process.exit(1); });
