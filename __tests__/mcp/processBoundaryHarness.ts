import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  token: string;
}

export interface TrackedStdioClient {
  client: Client;
  transport: StdioClientTransport;
  child: ChildProcess;
  notifications: unknown[];
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  close(): Promise<void>;
}

export interface RunningFlujo {
  baseUrl: string;
  child: ChildProcess;
  dataDir: string;
  rootsDir: string;
  logs(): string;
  close(): Promise<void>;
}

export function cleanEnv(extra: NodeJS.ProcessEnv = {}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
    ...Object.fromEntries(
      Object.entries(extra).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  };
}

export async function waitFor<T>(
  operation: () => Promise<T> | T,
  accept: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${options.description ?? 'condition'}.${suffix}`);
}

export async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function childFromTransport(transport: StdioClientTransport): ChildProcess {
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  if (!child?.pid) throw new Error('The MCP SDK did not expose the spawned stdio child process.');
  return child;
}

function exitWaiter(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectStdio(
  entrypoint: string,
  env: NodeJS.ProcessEnv = {},
): Promise<TrackedStdioClient> {
  const notifications: unknown[] = [];
  const client = new Client(
    { name: 'flujo-process-boundary-test', version: '1.0.0' },
    { capabilities: {} },
  );
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    notifications.push(notification.params);
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(entrypoint)],
    env: cleanEnv(env),
    stderr: 'pipe',
  });
  await client.connect(transport);
  const child = childFromTransport(transport);
  const exited = exitWaiter(child);
  let closed = false;
  return {
    client,
    transport,
    child,
    notifications,
    waitForExit: (timeoutMs = 5_000) => withTimeout(exited, timeoutMs, `stdio child ${child.pid} to exit`),
    close: async () => {
      if (closed) return;
      closed = true;
      let closeError: unknown;
      try {
        await client.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await withTimeout(exited, 5_000, `stdio child ${child.pid} to exit after close`);
      } catch (error) {
        child.kill('SIGKILL');
        await withTimeout(exited, 5_000, `stdio child ${child.pid} to be killed`);
        throw error;
      }
      if (closeError) throw closeError;
    },
  };
}

export async function connectHttp(url: string): Promise<Client> {
  const client = new Client(
    { name: 'flujo-http-process-boundary-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

export async function startProductionFlujo(entrypoint: string): Promise<RunningFlujo> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-process-boundary-app-'));
  const dataDir = path.join(sandbox, 'data');
  const rootsDir = path.join(sandbox, 'roots');
  await Promise.all([fs.mkdir(dataDir), fs.mkdir(rootsDir)]);
  const port = await reservePort();
  const chunks: string[] = [];
  const child = spawn(process.execPath, [path.resolve(entrypoint), '--no-open', '--port', String(port)], {
    cwd: path.dirname(path.dirname(path.resolve(entrypoint))),
    env: cleanEnv({
      FLUJO_DATA_DIR: dataDir,
      FLUJO_FS_ROOTS: rootsDir,
      FLUJO_BASH_ROOTS: rootsDir,
      FLUJO_PORT: String(port),
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => chunks.push(String(chunk)));
  child.stderr?.on('data', (chunk) => chunks.push(String(chunk)));
  const exited = exitWaiter(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/api/cwd`);
        return response.status;
      },
      (status) => status === 200,
      { timeoutMs: 45_000, intervalMs: 200, description: `FLUJO readiness at ${baseUrl}` },
    );
  } catch (error) {
    child.kill('SIGTERM');
    await withTimeout(exited, 5_000, 'failed FLUJO child cleanup').catch(() => child.kill('SIGKILL'));
    await fs.rm(sandbox, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${chunks.join('')}`);
  }
  let closed = false;
  return {
    baseUrl,
    child,
    dataDir,
    rootsDir,
    logs: () => chunks.join(''),
    close: async () => {
      if (closed) return;
      closed = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await withTimeout(exited, 10_000, `FLUJO child ${child.pid} to exit`).catch(async (error) => {
        child.kill('SIGKILL');
        await withTimeout(exited, 5_000, `FLUJO child ${child.pid} to be killed`);
        throw error;
      });
      await fs.rm(sandbox, { recursive: true, force: true });
    },
  };
}
