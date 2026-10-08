import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {
  handleMcpAppRuntimeHttpRequest,
  handleMcpAppRuntimeUpgrade,
  getMcpAppRuntimeBrokerSnapshot,
  issueMcpAppRuntimeBrokerEnvironment,
  MCP_APP_RUNTIME_PROOF_CHALLENGE_HEADER,
  MCP_APP_RUNTIME_PROOF_HEADER,
  MCP_APP_RUNTIME_PROOF_PATH,
  MCP_APP_RUNTIME_REGISTER_TOKEN_ENV,
  MCP_APP_RUNTIME_REGISTER_URL_ENV,
  resetMcpAppRuntimeBrokerForTests,
  revokeMcpAppRuntimeBrokerForServer,
} from '@/backend/mcpApps/runtimeBroker';
import { createStdioTransport } from '@/backend/services/mcp/connection';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { runWithWorkspace } from '@/utils/workspace';

const PROOF_PREFIX = 'flujo-mcp-app-runtime-proof-v1:';
const IDE_TOKEN = 'A'.repeat(32);

interface ResponseResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const serverSockets = new Map<http.Server, Set<net.Socket>>();

function listen(server: http.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  serverSockets.set(server, sockets);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
    for (const socket of serverSockets.get(server) ?? []) socket.destroy();
    serverSockets.delete(server);
  });
}

function request(options: http.RequestOptions, body?: unknown): Promise<ResponseResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
      },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.once('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function websocketHandshake(port: number, host: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('WebSocket handshake timed out'));
    }, 5_000);
    socket.once('connect', () => {
      socket.end([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Origin: https://host.example.test',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', chunk => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function appKeyFromHost(host: string | undefined): string | undefined {
  const candidate = host?.split(':')[0]?.split('.')[0];
  return candidate?.match(/^app[0-9a-f]{60}$/) ? candidate : undefined;
}

describe('MCP App sidecar runtime broker', () => {
  const servers: http.Server[] = [];
  const priorSandboxPort = process.env.FLUJO_MCP_APP_SANDBOX_PORT;

  beforeEach(() => resetMcpAppRuntimeBrokerForTests());

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
    resetMcpAppRuntimeBrokerForTests();
    if (priorSandboxPort === undefined) delete process.env.FLUJO_MCP_APP_SANDBOX_PORT;
    else process.env.FLUJO_MCP_APP_SANDBOX_PORT = priorSandboxPort;
  });

  it('injects registration credentials only into the managed MCP Apps transport', () => {
    const config = {
      name: 'runtime-broker-factory-test',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      rootPath: process.cwd(),
      _buildCommand: '',
      _installCommand: '',
      enableMcpApps: true,
    } as MCPServerConfig;

    const managed = createStdioTransport(config, { enableRuntimeBroker: true }) as unknown as {
      _serverParams?: { env?: Record<string, string> };
      __flujoRuntimeBrokerLeaseId?: string;
    };
    expect(managed.__flujoRuntimeBrokerLeaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(managed._serverParams?.env?.[MCP_APP_RUNTIME_REGISTER_URL_ENV]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/_flujo\/runtime\/register$/,
    );
    expect(managed._serverParams?.env?.[MCP_APP_RUNTIME_REGISTER_TOKEN_ENV])
      .toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getMcpAppRuntimeBrokerSnapshot().capabilities).toHaveLength(1);

    resetMcpAppRuntimeBrokerForTests();
    const probe = createStdioTransport(config) as unknown as {
      _serverParams?: { env?: Record<string, string> };
      __flujoRuntimeBrokerLeaseId?: string;
    };
    expect(probe.__flujoRuntimeBrokerLeaseId).toBeUndefined();
    expect(probe._serverParams?.env?.[MCP_APP_RUNTIME_REGISTER_URL_ENV]).toBeUndefined();
    expect(probe._serverParams?.env?.[MCP_APP_RUNTIME_REGISTER_TOKEN_ENV]).toBeUndefined();
    expect(getMcpAppRuntimeBrokerSnapshot().capabilities).toHaveLength(0);
  });

  it('proxies only a proved loopback target and its exact HTTP/WebSocket manifest', async () => {
    const issued = runWithWorkspace('broker-workspace', () =>
      issueMcpAppRuntimeBrokerEnvironment('mcp-vscode'));
    const token = issued.env[MCP_APP_RUNTIME_REGISTER_TOKEN_ENV];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.env[MCP_APP_RUNTIME_REGISTER_URL_ENV]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/_flujo\/runtime\/register$/,
    );

    const targetRequests: Array<{ method?: string; url?: string; host?: string }> = [];
    const target = http.createServer((req, res) => {
      if (req.url === MCP_APP_RUNTIME_PROOF_PATH) {
        const challenge = req.headers[MCP_APP_RUNTIME_PROOF_CHALLENGE_HEADER];
        const proof = createHmac('sha256', token)
          .update(`${PROOF_PREFIX}${String(challenge)}`, 'utf8')
          .digest('base64url');
        res.statusCode = 204;
        res.setHeader(MCP_APP_RUNTIME_PROOF_HEADER, proof);
        res.end();
        return;
      }
      targetRequests.push({ method: req.method, url: req.url, host: req.headers.host });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host }));
    });
    target.on('upgrade', (req, socket) => {
      targetRequests.push({ method: req.method, url: req.url, host: req.headers.host });
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
        .digest('base64');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'));
    });
    servers.push(target);
    const targetPort = await listen(target);

    const broker = http.createServer((req, res) => {
      const handled = handleMcpAppRuntimeHttpRequest(req, res, {
        originKey: appKeyFromHost(req.headers.host),
        publicUrlForOriginKey: key => `https://${key}.sandbox.example.test/sandbox.html`,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end('Not found');
      }
    });
    broker.on('upgrade', (req, socket, head) => {
      if (!handleMcpAppRuntimeUpgrade(req, socket, head, appKeyFromHost(req.headers.host))) {
        socket.destroy();
      }
    });
    servers.push(broker);
    const brokerPort = await listen(broker);

    const registration = await request({
      host: '127.0.0.1',
      port: brokerPort,
      path: '/_flujo/runtime/register',
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }, {
      version: 1,
      resourceUri: 'ui://mcp-vscode/workbench.html',
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      routes: [
        {
          path: `/ide/${IDE_TOKEN}`,
          match: 'prefix',
          httpMethods: ['GET', 'HEAD', 'POST'],
          websocket: true,
        },
        { path: '/stream', match: 'exact', websocket: true },
      ],
    });
    expect(registration.status).toBe(201);
    const registered = JSON.parse(registration.body) as {
      originKey: string; publicOrigin: string; publicBaseUrl: string;
    };
    expect(registered.originKey).toMatch(/^app[0-9a-f]{60}$/);
    expect(registered.publicOrigin).toBe(
      `https://${registered.originKey}.sandbox.example.test`,
    );
    expect(registered.publicBaseUrl).toBe(`${registered.publicOrigin}/`);

    // The bearer is single-use: a descendant inheriting the original stdio
    // environment cannot replace the approved manifest after registration.
    const replay = await request({
      host: '127.0.0.1',
      port: brokerPort,
      path: '/_flujo/runtime/register',
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }, {
      version: 1,
      resourceUri: 'ui://mcp-vscode/workbench.html',
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      routes: [{ path: '/session.json', match: 'exact', httpMethods: ['GET'] }],
    });
    expect(replay.status).toBe(401);

    const host = `${registered.originKey}.localhost`;
    const ide = await request({
      host: '127.0.0.1',
      port: brokerPort,
      path: `/ide/${IDE_TOKEN}/?folder=%2Fworkspace`,
      method: 'GET',
      headers: { host },
    });
    expect(ide.status).toBe(200);
    expect(JSON.parse(ide.body)).toMatchObject({
      method: 'GET',
      url: `/ide/${IDE_TOKEN}/?folder=%2Fworkspace`,
      host: `127.0.0.1:${targetPort}`,
    });

    expect((await request({
      host: '127.0.0.1', port: brokerPort, path: '/session.json', headers: { host },
    })).status).toBe(404);
    expect((await request({
      host: '127.0.0.1', port: brokerPort, path: `/ide/${IDE_TOKEN}`, method: 'DELETE', headers: { host },
    })).status).toBe(404);
    expect((await request({
      host: '127.0.0.1', port: brokerPort, path: '/stream', method: 'GET', headers: { host },
    })).status).toBe(404);
    expect((await request({
      host: '127.0.0.1',
      port: brokerPort,
      path: `/ide/${IDE_TOKEN}/`,
      headers: { host: `app${'f'.repeat(60)}.localhost` },
    })).status).toBe(404);

    const handshake = await websocketHandshake(brokerPort, host, '/stream?token=opaque');
    expect(handshake).toMatch(/^HTTP\/1\.1 101 /);
    expect(targetRequests).toContainEqual(expect.objectContaining({ url: '/stream?token=opaque' }));

    runWithWorkspace('broker-workspace', () =>
      revokeMcpAppRuntimeBrokerForServer('mcp-vscode'));
    expect((await request({
      host: '127.0.0.1', port: brokerPort, path: `/ide/${IDE_TOKEN}/`, headers: { host },
    })).status).toBe(404);
  });

  it('rejects a target that cannot prove possession of the child capability', async () => {
    const issued = runWithWorkspace('broker-workspace', () =>
      issueMcpAppRuntimeBrokerEnvironment('unproved'));
    const token = issued.env[MCP_APP_RUNTIME_REGISTER_TOKEN_ENV];

    const unproved = http.createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    servers.push(unproved);
    const targetPort = await listen(unproved);

    const broker = http.createServer((req, res) => {
      if (!handleMcpAppRuntimeHttpRequest(req, res, {
        publicUrlForOriginKey: key => `https://${key}.sandbox.example.test/`,
      })) {
        res.statusCode = 404;
        res.end();
      }
    });
    servers.push(broker);
    const brokerPort = await listen(broker);

    const registration = await request({
      host: '127.0.0.1',
      port: brokerPort,
      path: '/_flujo/runtime/register',
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }, {
      version: 1,
      resourceUri: 'ui://unproved/app',
      targetOrigin: `http://127.0.0.1:${targetPort}`,
      routes: [{ path: '/ide/proved-only', match: 'prefix', httpMethods: ['GET'] }],
    });

    expect(registration.status).toBe(403);
    expect(JSON.parse(registration.body)).toEqual({ error: 'runtime_target_proof_failed' });
  });
});
