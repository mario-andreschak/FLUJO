import http from 'node:http';
import type { AddressInfo } from 'node:net';

type ClientModule = typeof import('../../mcp-servers/flujo/src/client');
const names = ['FLUJO_MCP_WORKLOAD_TOKEN', 'FLUJO_MCP_WORKLOAD_AUDIENCE', 'FLUJO_BASE_URL', 'FLUJO_WORKSPACE', 'FLUJO_WORKER_MODE'] as const;
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalFetch = global.fetch;
// Format-only consumer equipment: this token is not evidence of server authorization.
const token = `flo_mcp1_${'A'.repeat(43)}`;
function loadClient(): ClientModule {
  let client!: ClientModule;
  jest.isolateModules(() => { client = jest.requireActual('../../mcp-servers/flujo/src/client'); });
  return client;
}
function configure(audience = 'http://127.0.0.1:4317') {
  process.env.FLUJO_MCP_WORKLOAD_TOKEN = token;
  process.env.FLUJO_MCP_WORKLOAD_AUDIENCE = audience;
  process.env.FLUJO_BASE_URL = audience;
  process.env.FLUJO_WORKSPACE = 'consumer-workspace';
}
beforeEach(() => { for (const name of names) delete process.env[name]; });
afterEach(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

it('sends only the captured workload credential and workspace to the reviewed origin', async () => {
  configure();
  const client = loadClient();
  process.env.FLUJO_MCP_WORKLOAD_TOKEN = `flo_mcp1_${'B'.repeat(43)}`;
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"tools":[]}' });
  global.fetch = fetchMock as typeof fetch;
  await client.flujoRequest('listTools');
  expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4317/api/mcp/flujo/tools', expect.objectContaining({
    redirect: 'error', headers: expect.objectContaining({ authorization: `Bearer ${token}`, 'x-flujo-workspace': 'consumer-workspace' }),
  }));
});

it.each(['https://outside.example', 'http://127.0.0.1:4318', 'http://127.0.0.1:4317/path', 'http://127.0.0.1:4317?query=1'])(
  'refuses destination drift before any request to %s', async destination => {
    configure(); const client = loadClient();
    const fetchMock = jest.fn(); global.fetch = fetchMock as typeof fetch;
    process.env.FLUJO_BASE_URL = destination;
    await expect(client.flujoRequest('listTools')).rejects.toThrow('destination or workspace changed');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('refuses workspace drift and worker-mode mixing before sending the captured capability', async () => {
  configure(); const client = loadClient();
  const fetchMock = jest.fn(); global.fetch = fetchMock as typeof fetch;
  process.env.FLUJO_WORKSPACE = 'another-workspace';
  await expect(client.flujoRequest('listTools')).rejects.toThrow('destination or workspace changed');
  process.env.FLUJO_WORKSPACE = 'consumer-workspace'; process.env.FLUJO_WORKER_MODE = '1';
  await expect(client.flujoRequest('listTools')).rejects.toThrow('destination or workspace changed');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('rejects partial credentials and a non-loopback audience at initialization', () => {
  process.env.FLUJO_MCP_WORKLOAD_TOKEN = token;
  expect(loadClient).toThrow('Invalid bundled FLUJO workload credentials');
  configure('https://outside.example');
  expect(loadClient).toThrow('exact loopback origin');
});
it('rejects late credential injection rather than falling back to owner or worker authority', async () => {
  const client = loadClient(); configure();
  const fetchMock = jest.fn(); global.fetch = fetchMock as typeof fetch;
  await expect(client.flujoRequest('listTools')).rejects.toThrow('before client initialization');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('does not follow an actual HTTP redirect carrying the workload bearer to another server', async () => {
  let targetRequests = 0;
  let sourceAuthorization: string | undefined;
  const target = http.createServer((_request, response) => { targetRequests += 1; response.end('{"tools":[]}'); });
  const source = http.createServer((request, response) => {
    sourceAuthorization = request.headers.authorization;
    response.writeHead(302, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/mcp/flujo/tools` }); response.end();
  });
  try {
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    configure(`http://127.0.0.1:${(source.address() as AddressInfo).port}`);
    const client = loadClient();
    await expect(client.flujoRequest('listTools')).rejects.toThrow();
    expect(sourceAuthorization).toBe(`Bearer ${token}`);
    expect(targetRequests).toBe(0);
  } finally {
    const closed = await Promise.allSettled([source, target].map(server => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }));
    const errors = closed.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Workload redirect consumer cleanup failed.');
  }
});
