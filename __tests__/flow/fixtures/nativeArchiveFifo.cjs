const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const root = process.argv[2], directory = process.argv[3], mode = process.argv[4];
process.env.FLUJO_DATA_DIR = path.join(directory, 'runtime');
const ts = require(path.join(root, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  return resolve.call(this, request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, ...args);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const archive = require(path.join(root, 'src/backend/execution/flow/modelTurnArchive.ts'));
const budget = require(path.join(root, 'src/backend/execution/flow/modelTurnArchiveReadBudget.ts'));
archive._setModelTurnArchiveDirForTests(directory);
const folder = path.join(directory, 'conversation');
fs.mkdirSync(folder);
const snapshot = path.join(folder, 'dispatch.v2.json.gz');
const companion = path.join(folder, 'dispatch.outcome.json');
fs.writeFileSync(snapshot, gzipSync(JSON.stringify({ version: 2,
  entry: { id: 'dispatch', conversationId: 'conversation', archiveVersion: 2, outcome: 'running' } })));
const target = mode === 'companion' ? companion : snapshot;
if (fs.existsSync(target)) fs.unlinkSync(target);
execFileSync('mkfifo', [target], { timeout: 1000 });
const open = fs.promises.open.bind(fs.promises);
let closed = 0, targetReads = 0, flags;
fs.promises.open = async (file, requestedFlags, ...args) => {
  if (file === target) {
    flags = mode === 'blocking-control' ? requestedFlags & ~fs.constants.O_NONBLOCK : requestedFlags;
    requestedFlags = flags;
  }
  const handle = await open(file, requestedFlags, ...args);
  const close = handle.close.bind(handle);
  handle.close = async () => { await close(); closed++; };
  if (file === target) {
    const read = handle.read.bind(handle);
    handle.read = async (...args) => { targetReads++; return read(...args); };
  }
  return handle;
};
const started = performance.now();
archive.readNativeModelTurnSnapshot('conversation', 'dispatch', 'default-workspace').then(() => {
  throw Error('FIFO was accepted');
}, error => {
  if (error.message !== 'Native model-turn archive changed.') throw error;
  console.log(JSON.stringify({ denied: true, nonblocking: Boolean(flags & fs.constants.O_NONBLOCK),
    closedDescriptors: closed, targetReads, activeReads: budget.getModelTurnArchiveReadDiagnostics().activeReads,
    elapsedMs: performance.now() - started }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
