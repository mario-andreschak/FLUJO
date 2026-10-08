#!/usr/bin/env node
/**
 * Isolated process-boundary smoke checks for the artifacts FLUJO actually ships.
 *
 * The default mode packs the root app and four public MCP workspaces, installs
 * only those local tarballs, launches the installed stdio binaries with npm in
 * offline mode, then starts the installed `flujo` CLI and probes its real
 * Streamable HTTP proxy. The install itself may resolve public transitive
 * dependencies: a fresh npm cache does not contain registry packuments merely
 * because `npm ci` previously fetched their lockfile-pinned tarballs.
 * `--proxy-only <url>` probes an already-running image.
 * `--candidate-dir <directory>` installs the exact validated release tarballs.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateCandidate } from './npm-release.mjs';
import { cleanupSmokeSandbox, observeSmokeChild, stopSmokeChild, withSmokeCleanup, withTimeout } from './mcp-smoke-cleanup.mjs';
import { approveSmokeServer, createSmokeOperator } from './smoke-bundled-operator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const publicPackages = ['filesystem', 'bash', 'browser', 'flujo'];
const timeoutMs = Number(process.env.FLUJO_SMOKE_TIMEOUT_MS || 90_000);

function cleanEnv(extra = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    ...extra,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? cleanEnv(),
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', (chunk) => output.push(String(chunk)));
    child.stderr.on('data', (chunk) => output.push(String(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const text = output.join('');
      if (code === 0) resolve(text);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}.\n${text}`));
    });
  });
}

export async function createPrivateSmokeEnv(sandbox, dataDir, extra = {}) {
  const secretFile = path.join(sandbox, 'operator-secret');
  await fs.writeFile(secretFile, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 });
  const env = cleanEnv({ ...extra, FLUJO_DATA_DIR: dataDir,
    FLUJO_ENCRYPTION_SECRET_FILE: secretFile, FLUJO_EXPOSURE_MODE: 'localhost' });
  delete env.FLUJO_OWNER_AUTH_FILE;
  delete env.FLUJO_PARENT_DATA_DIR;
  return env;
}

export async function waitFor(operation, accept, description, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  let lastError;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accept(value)) return value;
      lastError = undefined;
      if (Number.isInteger(value) && value >= 100 && value <= 599) lastStatus = value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}.${lastStatus === undefined ? '' : ` Last HTTP status: ${lastStatus}.`}${lastError instanceof Error ? ` Last error: ${lastError.message}` : ''}`);
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a local port.');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function connectStdio(entrypoint, env = {}, roots = []) {
  const client = new Client(
    { name: 'flujo-packed-artifact-smoke', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: roots.map((directory) => ({ uri: pathToFileURL(path.resolve(directory)).toString() })),
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: cleanEnv(env),
    stderr: 'pipe',
  });
  await client.connect(transport);
  const child = transport._process;
  if (!child?.pid) throw new Error(`No child process was created for ${entrypoint}.`);
  return { client, child };
}

async function withStdio(entrypoint, env, roots, operation) {
  const connected = await connectStdio(entrypoint, env, roots);
  const exited = waitForExit(connected.child);
  try {
    return await operation(connected.client, connected.child);
  } finally {
    let closeError;
    try {
      await connected.client.close();
    } catch (error) {
      closeError = error;
    }
    let result;
    try {
      result = await withTimeout(exited, 5_000, `stdio child ${connected.child.pid} to exit`);
    } catch (error) {
      connected.child.kill('SIGKILL');
      await withTimeout(exited, 5_000, `stdio child ${connected.child.pid} to be killed`);
      throw error;
    }
    if (result.signal || result.code !== 0) {
      throw new Error(`stdio child ${connected.child.pid} exited with ${result.signal ?? result.code}.`);
    }
    if (closeError) throw closeError;
  }
}

async function connectProxy(baseUrl, serverName, ownerToken) {
  const client = new Client(
    { name: 'flujo-packed-proxy-smoke', version: '1.0.0' },
    { capabilities: {} },
  );
  if (ownerToken) await approveSmokeServer(baseUrl, serverName, ownerToken, timeoutMs);
  await client.connect(new StreamableHTTPClientTransport(new URL(`/mcp-proxy/${serverName}`, baseUrl), {
    requestInit: { headers: ownerToken ? { authorization: `Bearer ${ownerToken}` } : {} },
  }));
  return client;
}

async function updateBuiltIn(baseUrl, serverName, patch, ownerToken) {
  const response = await fetch(new URL(`/api/mcp/servers/${serverName}`, baseUrl), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Could not update ${serverName}: ${response.status} ${await response.text()}`);
}

export async function probeProxy(baseUrl, expectedRoot, ownerToken) {
  const headers = ownerToken ? { authorization: `Bearer ${ownerToken}` } : {};
  const readiness = await fetch(new URL('/api/cwd', baseUrl), { headers });
  if (!readiness.ok) throw new Error(`FLUJO readiness returned ${readiness.status}.`);
  // Next.js can accept requests before the fire-and-forget backend startup has
  // provisioned and connected the shipped MCP servers. Join that same memoized
  // initialization explicitly so the proxy probe tests artifacts, not timing.
  const initialized = await fetch(new URL('/api/init', baseUrl), { headers });
  if (!initialized.ok) {
    throw new Error(`FLUJO initialization returned ${initialized.status}: ${await initialized.text()}`);
  }

  const filesystem = await connectProxy(baseUrl, 'filesystem', ownerToken);
  try {
    const listed = await filesystem.listTools();
    const names = listed.tools.map((tool) => tool.name);
    if (!names.includes('read_file') || !names.includes('get_allowed_directories')) {
      throw new Error(`Installed filesystem proxy returned unexpected tools: ${names.join(', ')}`);
    }
    const roots = await filesystem.callTool({ name: 'get_allowed_directories', arguments: {} });
    if (roots.isError === true) {
      const refusalCodes = ['HOST_CONSENT_REQUIRED', 'HOST_SOURCE_CHANGED', 'MCP_RUNTIME_AUTHORITY_RETIRED'];
      const code = refusalCodes.find((candidate) => Array.isArray(roots.content) && roots.content.some((item) =>
        item.type === 'text' && typeof item.text === 'string' && item.text.slice(0, 8192).includes(candidate)
      )) ?? 'UNCLASSIFIED_TOOL_ERROR';
      throw new Error(`Filesystem proxy get_allowed_directories returned an error result (${code}).`);
    }
    const directories = roots.structuredContent?.directories;
    const resolvedExpectedRoot = expectedRoot ? path.resolve(expectedRoot) : undefined;
    if (
      resolvedExpectedRoot && (
        !Array.isArray(directories) ||
        !directories.some((directory) =>
          typeof directory === 'string' &&
          path.resolve(directory).localeCompare(resolvedExpectedRoot, undefined, { sensitivity: 'accent' }) === 0
        )
      )
    ) {
      throw new Error(`Filesystem proxy did not retain its disposable root: ${JSON.stringify(roots.structuredContent)}`);
    }
  } finally {
    await filesystem.close();
  }

  const bash = await connectProxy(baseUrl, 'bash', ownerToken);
  try {
    const names = (await bash.listTools()).tools.map((tool) => tool.name);
    if (!names.includes('run') || !names.includes('list_sessions')) {
      throw new Error(`Installed bash proxy returned unexpected tools: ${names.join(', ')}`);
    }
  } finally {
    await bash.close();
  }

  const flujo = await connectProxy(baseUrl, 'flujo', ownerToken);
  try {
    const names = (await flujo.listTools()).tools.map((tool) => tool.name);
    if (!names.includes('list_flows') || !names.includes('list_mcp_servers')) {
      throw new Error(`Installed flujo proxy returned unexpected tools: ${names.join(', ')}`);
    }
    const resources = await flujo.listResources();
    if (!Array.isArray(resources.resources)) throw new Error('Flujo proxy did not return an MCP resource list.');
    const templates = await flujo.listResourceTemplates();
    if (!templates.resourceTemplates.some((entry) => entry.uriTemplate === 'flujo://run/{conversationId}/{resourceId}')) {
      throw new Error('Flujo proxy omitted the run-resource template.');
    }
  } finally {
    await flujo.close();
  }

  await updateBuiltIn(baseUrl, 'bash', { disabled: true }, ownerToken);
  const rejected = await fetch(new URL('/mcp-proxy/bash', baseUrl), {
    method: 'POST',
    headers: {
      ...headers,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'disabled-gate-smoke', version: '1.0.0' },
      },
    }),
  });
  if (rejected.status !== 404) {
    throw new Error(`Disabled proxy should return 404, received ${rejected.status}: ${await rejected.text()}`);
  }
  await updateBuiltIn(baseUrl, 'bash', { disabled: false }, ownerToken);
  const restarted = await connectProxy(baseUrl, 'bash', ownerToken);
  try {
    if (!(await restarted.listTools()).tools.some((tool) => tool.name === 'run')) {
      throw new Error('Re-enabled bash proxy did not establish a fresh connection.');
    }
  } finally {
    await restarted.close();
  }
}

async function pack(target, destination) {
  const output = await run(npmCommand, [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination', destination,
    target,
  ]);
  const result = JSON.parse(output);
  if (!Array.isArray(result) || !result[0]?.filename) {
    throw new Error(`npm pack returned no tarball for ${target}.`);
  }
  return path.join(destination, result[0].filename);
}

async function startFakeFlujoApi() {
  const server = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/mcp/flujo/tools') {
      response.end(JSON.stringify({
        tools: [{ name: 'list_flows', description: 'packed smoke', inputSchema: { type: 'object', properties: {} } }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/mcp/flujo/flows') {
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'packed-pong' }] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/mcp/flujo/resources') {
      response.end(JSON.stringify({ resources: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/mcp/flujo/resource-templates') {
      response.end(JSON.stringify({ resourceTemplates: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake FLUJO API did not bind a port.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function smokePackedArtifacts(candidateDirectory) {
  await fs.access(path.join(root, '.next', 'BUILD_ID')).catch(() => {
    throw new Error('The root production build is missing. Run `npm run build` before the artifact smoke test.');
  });

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-packed-artifacts-'));
  const tarballsDir = path.join(sandbox, 'tarballs');
  const installDir = path.join(sandbox, 'install');
  const dataDir = path.join(sandbox, 'data');
  const rootsDir = path.join(sandbox, 'roots');
  await Promise.all([
    fs.mkdir(tarballsDir),
    fs.mkdir(installDir),
    fs.mkdir(dataDir),
    fs.mkdir(rootsDir),
  ]);

  let appChild;
  let appObservation;
  let operator;
  const appLogs = [];
  await withSmokeCleanup(async () => {
    let tarballs;
    if (candidateDirectory) {
      const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
      const sha = (await run('git', ['rev-parse', 'HEAD'])).trim();
      const manifest = validateCandidate({ directory: candidateDirectory, sha, version });
      tarballs = manifest.packages.map((item) => path.join(candidateDirectory, item.filename));
    } else {
      tarballs = [await pack('.', tarballsDir)];
      for (const packageName of publicPackages) {
        tarballs.push(await pack(`./mcp-servers/${packageName}`, tarballsDir));
      }
    }
    await fs.writeFile(path.join(installDir, 'package.json'), JSON.stringify({ private: true }), 'utf8');
    await run(npmCommand, [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...tarballs,
    ], {
      cwd: installDir,
      // `cleanEnv()` deliberately makes every launched artifact offline. The
      // one realistic exception is installation: npm packages do not bundle
      // their third-party dependencies, so a clean consumer resolves them from
      // the registry just like `npm install flujo-ai` does.
      env: cleanEnv({ npm_config_offline: 'false', npm_config_prefer_offline: 'true' }),
    });

    const installedModules = path.join(installDir, 'node_modules');
    const entries = Object.fromEntries(publicPackages.map((name) => [
      name,
      path.join(installedModules, '@mario.andreschak', `mcp-${name}`, 'dist', 'index.js'),
    ]));
    for (const [name, entrypoint] of Object.entries(entries)) {
      await fs.access(entrypoint);
      if (!path.resolve(entrypoint).startsWith(path.resolve(installDir) + path.sep)) {
        throw new Error(`${name} resolved outside the isolated install: ${entrypoint}`);
      }
    }

    await withStdio(entries.filesystem, {
      FLUJO_DATA_DIR: dataDir,
      FLUJO_FS_ROOTS: rootsDir,
    }, [rootsDir], async (client, child) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      if (!names.includes('read_file') || child.pid === process.pid) throw new Error('Packed filesystem did not cross a process boundary.');
      const result = await client.callTool({ name: 'get_allowed_directories', arguments: {} });
      const directories = result.structuredContent?.directories;
      const expectedRoot = path.resolve(rootsDir);
      if (
        !Array.isArray(directories) ||
        !directories.some((directory) =>
          typeof directory === 'string' &&
          path.resolve(directory).localeCompare(expectedRoot, undefined, { sensitivity: 'accent' }) === 0
        )
      ) {
        throw new Error('Packed filesystem did not enforce the disposable root.');
      }
    });

    await withStdio(entries.bash, {
      FLUJO_DATA_DIR: dataDir,
      FLUJO_BASH_ROOTS: rootsDir,
    }, [rootsDir], async (client, child) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      if (!names.includes('run') || child.pid === process.pid) throw new Error('Packed bash did not cross a process boundary.');
    });

    await withStdio(entries.browser, { FLUJO_DATA_DIR: dataDir }, [], async (client, child) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      if (!names.includes('browser_open') || child.pid === process.pid) {
        throw new Error('Packed browser did not cross a process boundary.');
      }
    });

    const fakeApi = await startFakeFlujoApi();
    try {
      await withStdio(entries.flujo, { FLUJO_BASE_URL: fakeApi.url }, [], async (client, child) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        if (names.join(',') !== 'list_flows' || child.pid === process.pid) throw new Error('Packed flujo did not cross a process boundary.');
        const called = await client.callTool({ name: 'list_flows', arguments: {} });
        if (!JSON.stringify(called.content).includes('packed-pong')) throw new Error('Packed flujo did not call its localhost control API.');
      });
    } finally {
      await fakeApi.close();
    }

    const appRoot = path.join(installedModules, 'flujo-ai');
    const appEntrypoint = path.join(appRoot, 'bin', 'flujo.mjs');
    await fs.access(appEntrypoint);
    const port = await reservePort();
    let sandboxPort = await reservePort();
    while (sandboxPort === port) sandboxPort = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    operator = await createSmokeOperator();
    appChild = spawn(process.execPath, [appEntrypoint, '--no-open', '--port', String(port)], {
      cwd: appRoot,
      env: { ...await createPrivateSmokeEnv(sandbox, dataDir, {
        FLUJO_LOCAL_INSTANCE_DIR: path.join(sandbox, 'instances'),
        FLUJO_FS_ROOTS: rootsDir,
        FLUJO_BASH_ROOTS: rootsDir,
        FLUJO_PORT: String(port),
        FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort),
        FLUJO_MCP_WORKLOAD_TRACE: '1',
      }), ...operator.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appObservation = observeSmokeChild(appChild);
    appChild.stdout.on('data', (chunk) => appLogs.push(String(chunk)));
    appChild.stderr.on('data', (chunk) => appLogs.push(String(chunk)));
    appChild.once('error', (error) => appLogs.push(`Installed FLUJO spawn error: ${error.stack ?? error.message}\n`));
    await waitFor(
      async () => (await fetch(new URL('/api/cwd', baseUrl), { headers: { authorization: `Bearer ${operator.token}` } })).status,
      (status) => status === 200,
      `installed FLUJO readiness at ${baseUrl}`,
    );
    await probeProxy(baseUrl, rootsDir, operator.token);
  }, () => withSmokeCleanup(() => cleanupSmokeSandbox({
    stop: async () => {
      if (appObservation) await stopSmokeChild(appObservation, 'installed flujo CLI');
    },
    remove: fs.rm,
    sandbox,
  }), async () => { if (operator) await operator.restore(); })).catch((error) => {
    const logs = appLogs.join('');
    throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}${logs ? `\nInstalled FLUJO logs:\n${logs}` : ''}`, { cause: error });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const proxyOnlyIndex = process.argv.indexOf('--proxy-only');
if (proxyOnlyIndex !== -1) {
  const baseUrl = process.argv[proxyOnlyIndex + 1];
  if (!baseUrl) throw new Error('--proxy-only requires a base URL.');
  await waitFor(
    async () => (await fetch(new URL('/api/cwd', baseUrl))).status,
    (status) => status === 200,
    `container FLUJO readiness at ${baseUrl}`,
  );
  await probeProxy(baseUrl, process.env.FLUJO_SMOKE_EXPECTED_ROOT);
  console.log(`Validated the live MCP proxy at ${baseUrl}.`);
} else {
  const candidateIndex = process.argv.indexOf('--candidate-dir');
  const candidateDirectory = candidateIndex === -1 ? undefined : process.argv[candidateIndex + 1];
  if (candidateIndex !== -1 && (!candidateDirectory || !path.isAbsolute(candidateDirectory))) throw new Error('--candidate-dir requires an absolute artifact directory.');
  await smokePackedArtifacts(candidateDirectory);
  console.log('Validated isolated packed MCP binaries and the installed FLUJO proxy.');
}
}
