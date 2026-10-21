// Executed inside the selected container by a fixed docker-exec command. It has
// no caller-selected address, command, filesystem path or host-network access.
import { createConnection } from 'node:net';

if (process.argv.length !== 2) process.exit(1);
const socket = createConnection({ host: '127.0.0.1', port: 4200 });
let done = false;
const connectDeadline = setTimeout(() => finish(1), 10_000);
const lifetime = setTimeout(() => finish(1), 60 * 60 * 1000);
function finish(code: number) {
  if (done) return;
  done = true;
  clearTimeout(connectDeadline); clearTimeout(lifetime);
  socket.destroy(); process.stdin.destroy(); process.stdout.end();
  process.exitCode = code;
}
socket.on('connect', () => {
  clearTimeout(connectDeadline);
  process.stdin.pipe(socket); socket.pipe(process.stdout);
});
socket.on('error', () => finish(1));
socket.on('close', () => finish(0));
process.stdin.on('error', () => finish(1));
process.stdin.on('end', () => finish(0));
process.stdout.on('error', () => finish(1));
process.stdout.on('close', () => finish(0));
process.once('SIGTERM', () => finish(0));
process.once('SIGINT', () => finish(0));
