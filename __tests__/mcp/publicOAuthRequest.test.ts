import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { DetailedPeerCertificate } from 'node:tls';
import { isPublicOAuthAddress, publicOAuthEndpoint, publicOAuthUrl, requestPublicOAuth } from '@/utils/mcp/publicOAuthRequest';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
const dns = lookup as unknown as jest.Mock;
const network = request as unknown as jest.Mock;
let response: PassThrough & { statusCode: number; headers: Record<string, string> };
let body: Buffer;
let end: jest.Mock;

beforeEach(() => {
  dns.mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
  network.mockReset();
  body = Buffer.from('{"resource":"https://mcp.example.com"}');
  response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
  response.on('error', () => undefined);
  end = jest.fn(() => {
    queueMicrotask(() => {
      const options = network.mock.calls[0][0] as RequestOptions;
      const callback = network.mock.calls[0][1] as (res: IncomingMessage) => void;
      callback(response as unknown as IncomingMessage);
      if (options.method === 'GET' && !response.destroyed) response.end(body);
    });
  });
  network.mockImplementation(() => Object.assign(new EventEmitter(), { end }) as unknown as ClientRequest);
});
afterEach(() => { response.destroy(); });

test.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
  '172.16.0.1', '192.168.0.1', '192.0.0.9', '192.0.2.1', '198.18.0.1', '198.51.100.1',
  '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1',
  '64:ff9b::a00:1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2002:a00:1::', '3fff::1'])
('special/local address %s is denied', address => {
  expect(isPublicOAuthAddress(address)).toBe(false);
});

test.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])
('public address %s is admitted', address => {
  expect(isPublicOAuthAddress(address)).toBe(true);
});

test.each(['http://mcp.example.com/mcp', 'https://localhost/mcp', 'https://127.1/mcp',
  'https://2130706433/mcp', 'https://[::ffff:127.0.0.1]/mcp', 'https://metadata.internal/mcp',
  'https://user:synthetic-secret@mcp.example.com/mcp', 'https://mcp.example.com:8443/mcp',
  'https://mcp.example.com/mcp?access_token=synthetic-secret', 'https://mcp.example.com/mcp#fragment'])
('URL %s is denied before DNS or network access', async value => {
  await expect(requestPublicOAuth(value, 'challenge', new AbortController().signal)).rejects.toThrow('OAuth probe egress denied');
  expect(dns).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

test.each([
  { records: [{ address: '127.0.0.1', family: 4 }] },
  { records: [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] },
  { records: [{ address: '::ffff:127.0.0.1', family: 6 }] },
  { records: [{ address: '1.1.1.1', family: 6 }] },
  { records: [] },
])('denied/mixed/invalid DNS records never reach HTTPS', async ({ records }) => {
  dns.mockResolvedValue(records);
  await expect(requestPublicOAuth('https://mcp.example.com/mcp', 'metadata', new AbortController().signal)).rejects.toThrow('OAuth probe egress denied');
  expect(network).not.toHaveBeenCalled();
});

test('the request connects to the admitted numeric address while binding Host, SNI and TLS verification to the original name', async () => {
  const signal = new AbortController().signal;
  const result = await requestPublicOAuth('https://mcp.example.com/mcp', 'challenge', signal);
  expect(result.ok).toBe(true);
  const options = network.mock.calls[0][0] as RequestOptions;
  expect(options).toMatchObject({ protocol: 'https:', hostname: '1.1.1.1', port: 443,
    family: 4, servername: 'mcp.example.com', rejectUnauthorized: true, agent: false, signal,
    path: '/mcp', method: 'POST', maxHeaderSize: 16_384 });
  expect(options.headers).toMatchObject({ host: 'mcp.example.com', 'content-type': 'application/json' });
  expect(options.headers).not.toHaveProperty('authorization');
  expect(options.headers).not.toHaveProperty('cookie');
  const certificate = { subjectaltname: 'DNS:mcp.example.com' } as DetailedPeerCertificate;
  expect(options.checkServerIdentity?.('1.1.1.1', certificate)).toBeUndefined();
  expect(options.checkServerIdentity?.('1.1.1.1', { subjectaltname: 'DNS:other.example.com' } as DetailedPeerCertificate))
    .toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  expect(JSON.parse(end.mock.calls[0][0])).toEqual({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  expect(response.destroyed).toBe(true); // Header-only challenge closes a possible SSE response.
});

test('DNS is not consulted a second time after address admission', async () => {
  dns.mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  const result = await requestPublicOAuth('https://mcp.example.com/metadata', 'metadata', new AbortController().signal);
  expect(await result.json()).toEqual({ resource: 'https://mcp.example.com' });
  expect(dns).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][0].hostname).toBe('1.1.1.1');
});

test('a redirect toward a local address is closed without following it', async () => {
  response.statusCode = 302;
  response.headers.location = 'https://127.0.0.1/private';
  const result = await requestPublicOAuth('https://mcp.example.com/metadata', 'metadata', new AbortController().signal);
  expect(result.ok).toBe(false);
  expect(network).toHaveBeenCalledTimes(1);
  expect(response.destroyed).toBe(true);
});

test('metadata bodies are bounded', async () => {
  body = Buffer.alloc(65_537, 0x61);
  await expect(requestPublicOAuth('https://mcp.example.com/metadata', 'metadata', new AbortController().signal)).rejects.toThrow('OAuth probe egress denied');
  expect(response.destroyed).toBe(true);
});

test('compressed metadata is rejected without expansion', async () => {
  response.headers['content-encoding'] = 'gzip';
  await expect(requestPublicOAuth('https://mcp.example.com/metadata', 'metadata', new AbortController().signal)).rejects.toThrow('OAuth probe egress denied');
});

test('an aborted DNS lookup cannot later open a request', async () => {
  let finish!: (records: unknown) => void;
  dns.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = requestPublicOAuth('https://mcp.example.com/metadata', 'metadata', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('OAuth probe egress denied');
  finish([{ address: '1.1.1.1', family: 4 }]);
  await Promise.resolve();
  expect(network).not.toHaveBeenCalled();
});

test('public endpoint validation preserves the exact issuer identifier', async () => {
  const issuer = 'https://auth.example.com';
  expect(await publicOAuthEndpoint(issuer, new AbortController().signal)).toBe(issuer);
  expect(publicOAuthUrl('https://fconline.example.com/mcp').hostname).toBe('fconline.example.com');
});
