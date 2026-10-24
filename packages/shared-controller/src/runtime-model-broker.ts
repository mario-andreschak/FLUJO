import { createRuntimeModelServer } from './runtime-model-server.js';

if (process.argv.length !== 2 || process.getuid?.() !== 1000 || process.env.FLUJO_CONTAINER !== '1') process.exit(1);
const broker = createRuntimeModelServer(process.stdin, process.stdout);
broker.server.listen(4290, '127.0.0.1');
process.once('SIGTERM', broker.close); process.once('SIGINT', broker.close);
