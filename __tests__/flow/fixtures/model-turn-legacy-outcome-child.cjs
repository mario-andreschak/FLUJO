// Actual Source boundary under a declared 128 MiB heap / 512 MiB RSS budget.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const fixture = path.resolve(process.argv[2]);
process.env.FLUJO_DATA_DIR = path.join(fixture, 'runtime');
const ts = require(path.join(root, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, ...rest);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const archive = require(path.join(root, 'src/backend/execution/flow/modelTurnArchive.ts'));
const budget = require(path.join(root, 'src/backend/execution/flow/modelTurnArchiveReadBudget.ts'));
archive._setModelTurnArchiveDirForTests(fixture);
const file = path.join(fixture, 'conversation/dispatch.json.gz');
const digest = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
(async () => {
  const before = digest();
  let limited = 0, peakRss = process.memoryUsage().rss;
  const observe = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      try { await archive.updateModelDispatchOutcome('conversation', 'dispatch', 'completed'); }
      catch (error) { if (error.code !== 'MODEL_TURN_ARCHIVE_READ_LIMIT' || error.status !== 413) throw error; limited++; }
      if (limited !== attempt + 1 || digest() !== before) throw new Error('Legacy outcome bypassed admission or changed persisted history');
      global.gc?.();
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.stdout.write(JSON.stringify({ attempts: 6, limited, activeReads: budget.getModelTurnArchiveReadDiagnostics().activeReads,
      persistedUnchanged: digest() === before, peakRss }) + '\n');
  } finally { clearInterval(observe); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
