'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ts = require('typescript');
const Module = require('module');

const repositoryRoot = process.cwd();
const stdioOAuthDist = path.join(repositoryRoot, 'node_modules', 'mcp-stdio-oauth', 'dist');
const stdioOAuthSubpaths = new Map([
  ['mcp-stdio-oauth/client', path.join(stdioOAuthDist, 'client', 'index.js')],
  ['mcp-stdio-oauth/client/transport', path.join(stdioOAuthDist, 'client', 'transport.js')],
  ['mcp-stdio-oauth/protocol', path.join(stdioOAuthDist, 'protocol', 'index.js')],
]);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (stdioOAuthSubpaths.has(request)) {
    // The application is transpiled to CommonJS in this deliberately bare
    // subprocess, while mcp-stdio-oauth exposes import-only ESM conditions.
    // Resolve its documented subpaths to their artifacts; the .js hook below
    // performs the same ESM-to-CJS adaptation Jest applies in the parent.
    request = stdioOAuthSubpaths.get(request);
  } else if (request.startsWith('@/')) {
    request = path.join(repositoryRoot, 'src', request.slice(2));
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
const originalJavaScriptLoader = require.extensions['.js'];
require.extensions['.js'] = function transpileSelectedEsm(module, filename) {
  if (!filename.startsWith(stdioOAuthDist + path.sep)) {
    return originalJavaScriptLoader(module, filename);
  }
  const outputText = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(outputText, filename);
};
require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const outputText = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(outputText, filename);
};

const workspaceId = process.argv[2];
if (!workspaceId) throw new Error('A workspace id is required.');

const enduringAgents = require(path.join(
  repositoryRoot,
  'src/backend/services/enduringAgents/index.ts',
));
const { flowService } = require(path.join(repositoryRoot, 'src/backend/services/flow/index.ts'));
const { StorageKey } = require(path.join(repositoryRoot, 'src/shared/types/storage/index.ts'));
const { saveItem } = require(path.join(repositoryRoot, 'src/utils/storage/backend.ts'));
const { runWithWorkspace } = require(path.join(repositoryRoot, 'src/utils/workspace.ts'));

function leaseFence(claim) {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.activity.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

async function execute(command) {
  return runWithWorkspace(workspaceId, async () => {
    switch (command.type) {
      case 'createPersona':
        await saveItem(StorageKey.MODELS, [{
          id: 'model-test',
          name: 'test-model',
          displayName: 'Test model',
          provider: 'openai',
        }]);
        if (!await flowService.getFlow(command.coreFlowRef)) {
          await flowService.saveFlow({
            id: command.coreFlowRef,
            name: `Persona process core ${command.coreFlowRef}`,
            nodes: [
              {
                id: 'start',
                type: 'start',
                position: { x: 0, y: 0 },
                data: { type: 'start', label: 'Start', properties: {} },
              },
              {
                id: 'primary',
                type: 'process',
                position: { x: 240, y: 0 },
                data: {
                  type: 'process',
                  label: 'Primary behavior',
                  properties: {
                    promptTemplate: 'Complete the assigned task using the supplied Persona context.',
                    boundModel: 'model-test',
                  },
                },
              },
              {
                id: 'finish',
                type: 'finish',
                position: { x: 480, y: 0 },
                data: { type: 'finish', label: 'Finish', properties: {} },
              },
            ],
            edges: [
              {
                id: 'start-to-primary',
                source: 'start',
                target: 'primary',
              },
              {
                id: 'primary-to-finish',
                source: 'primary',
                target: 'finish',
              },
            ],
          });
        }
        return enduringAgents.createPersonaFromRole({
          name: command.name,
          coreFlowRef: command.coreFlowRef,
          idempotencyKey: command.idempotencyKey,
          ...(command.interruptionPolicy
            ? { interruptionPolicy: command.interruptionPolicy }
            : {}),
        });
      case 'enqueue':
        return enduringAgents.enqueuePersonaMailboxItem(command.input);
      case 'route':
        return enduringAgents.routePersonaMailboxItem(command.input);
      case 'claim': {
        const claim = await enduringAgents.claimNextPersonaActivity({
          personaId: command.personaId,
          ttlMs: command.ttlMs ?? 30_000,
        });
        return claim ? { ...claim, fence: leaseFence(claim) } : null;
      }
      case 'release':
        return enduringAgents.releasePersonaActivityLease(command.fence);
      case 'complete':
        return enduringAgents.completePersonaActivity(command.fence);
      case 'assertFence':
        return enduringAgents.assertPersonaActivityLease(command.fence);
      case 'inspect':
        return enduringAgents.listPersonaRuntimeBundle(command.personaId);
      case 'reconcile':
        return enduringAgents.inspectAndReconcilePersonaRuntime(command.personaId);
      case 'shutdown':
        return { shuttingDown: true };
      default:
        throw new Error(`Unsupported Persona child command: ${command.type}`);
    }
  });
}

function serializedError(error) {
  return {
    name: error && error.name ? String(error.name) : 'Error',
    message: error && error.message ? String(error.message) : String(error),
    ...(error && error.code ? { code: String(error.code) } : {}),
  };
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const value = await execute(request.command);
    const response = `${JSON.stringify({ id: request.id, ok: true, value })}\n`;
    if (request.command.type === 'shutdown') {
      process.stdout.write(response, () => {
        input.close();
        process.exit(0);
      });
    } else {
      process.stdout.write(response);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: request && request.id,
      ok: false,
      error: serializedError(error),
    })}\n`);
  }
});

process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid })}\n`);
