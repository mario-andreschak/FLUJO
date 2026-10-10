'use strict';
// Source-only process witness, following the existing Persona fixture loader.
// No application build, installed-artifact acceptance, provider or model call.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = process.cwd();
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
  return originalResolve.call(this, request, parent, isMain, options);
};
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  module._compile(output, filename);
};
const recovery = require(path.join(root, 'src/backend/services/scheduler/workerLocalRecovery.ts'));
const { setWorkerBootstrapStatus } = require(path.join(root, 'src/backend/services/workspace/workerMode.ts'));
const { getCurrentWorkspace } = require(path.join(root, 'src/utils/workspace.ts'));
const [phase, id] = process.argv.slice(2);
const plan = { id, generationId: 'process-generation-a', createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z', name: 'Process fixture', enabled: true, flowId: 'fixture-flow',
  prompt: 'fixture', overlapStrategy: 'skip', trigger: { type: 'schedule', cron: '* * * * *', catchUp: true } };
setWorkerBootstrapStatus({ state: 'ready', workspace: getCurrentWorkspace() });
(async () => {
  if (phase === 'seed-hold') {
    await recovery.recordWorkerLocalCreation(plan);
    await recovery.enrollWorkerRecovery(plan, true, plan.generationId, recovery.workerRecoveryDefinitionSha256(plan));
    const admitted = await recovery.claimWorkerOccurrence(plan, '2026-10-03T12:00:00.000Z', 'original-run-a');
    process.stdout.write(JSON.stringify({ ready: true, admitted }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify(await recovery.inspectWorkerRecovery(plan, false)) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
