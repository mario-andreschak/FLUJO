'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const ts = require('typescript');
const Module = require('module');

// ---------------------------------------------------------------------------
// On-disk transpile cache (issue #457).
//
// This fixture re-transpiled the entire enduringAgents dependency graph from
// scratch on every spawn, and the suite spawns eight children. That startup
// cost — not any product behaviour — is what made the readiness wait time out
// under CPU contention. Caching the emitted JavaScript by content hash makes
// every spawn after the first one nearly free, and is shared across the whole
// run (and across runs on the same machine).
// ---------------------------------------------------------------------------
const transpileCacheDir = process.env.FLUJO_PERSONA_TRANSPILE_CACHE_DIR
  || path.join(os.tmpdir(), `flujo-persona-transpile-cache-ts${ts.version}`);
let transpileCacheUsable = true;
try {
  fs.mkdirSync(transpileCacheDir, { recursive: true });
} catch {
  transpileCacheUsable = false;
}

function transpileCached(variant, filename, source, compilerOptions) {
  if (!transpileCacheUsable) {
    return ts.transpileModule(source, { compilerOptions, fileName: filename }).outputText;
  }
  const key = crypto
    .createHash('sha1')
    .update(variant)
    .update('\0')
    .update(source)
    .digest('hex');
  const cacheFile = path.join(transpileCacheDir, `${variant}-${key}.js`);
  try {
    return fs.readFileSync(cacheFile, 'utf8');
  } catch {
    // Cache miss: fall through and compile.
  }
  const outputText = ts.transpileModule(source, { compilerOptions, fileName: filename }).outputText;
  // Write via a unique temp file so concurrent children can never observe a
  // half-written cache entry.
  const tempFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, outputText, 'utf8');
    fs.renameSync(tempFile, cacheFile);
  } catch {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // The cache is an optimisation; never fail the child over it.
    }
  }
  return outputText;
}

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
  const outputText = transpileCached('js', filename, fs.readFileSync(filename, 'utf8'), {
    allowJs: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  });
  module._compile(outputText, filename);
};
require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const outputText = transpileCached('ts', filename, fs.readFileSync(filename, 'utf8'), {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  });
  module._compile(outputText, filename);
};

const workspaceId = process.argv[2];
if (!workspaceId) throw new Error('A workspace id is required.');

const enduringAgents = require(path.join(
  repositoryRoot,
  'src/backend/services/enduringAgents/index.ts',
));
const { flowService } = require(path.join(repositoryRoot, 'src/backend/services/flow/index.ts'));
const {
  initializePersonaRuntimeLockProcessIdentity,
} = require(path.join(
  repositoryRoot,
  'src/backend/services/enduringAgents/runtimeLock.ts',
));
const { StorageKey } = require(path.join(repositoryRoot, 'src/shared/types/storage/index.ts'));
const { saveItem } = require(path.join(repositoryRoot, 'src/utils/storage/backend.ts'));
const { runWithWorkspace } = require(path.join(repositoryRoot, 'src/utils/workspace.ts'));
const {
  ensureTestRole,
  TEST_ROLE_VERSION_ID,
} = require(path.join(repositoryRoot, '__tests__/enduringAgents/fixtures/personaFactory.ts'));

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
        await ensureTestRole();
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
          roleVersionId: TEST_ROLE_VERSION_ID,
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
      case 'appendEvent':
        return enduringAgents.appendPersonaRuntimeEvent(command.personaId, command.event);
      case 'readEvents':
        return enduringAgents.readPersonaRuntimeEvents(command.personaId);
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

async function announceReady() {
  // Importing the graph is not sufficient readiness on Windows: Persona lock
  // acquisition lazily launches PowerShell to establish the process birth
  // marker. Retry transient startup probes *before* advertising readiness so
  // the first lock-taking command does not race OS identity setup (issue #457).
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await initializePersonaRuntimeLockProcessIdentity();
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  process.stdout.write(`${JSON.stringify({ type: 'ready', pid: process.pid })}\n`);
}

void announceReady().catch((error) => {
  process.stderr.write(`Persona child initialization failed: ${
    error instanceof Error ? error.stack ?? error.message : String(error)
  }\n`);
  input.close();
  process.exitCode = 1;
});
