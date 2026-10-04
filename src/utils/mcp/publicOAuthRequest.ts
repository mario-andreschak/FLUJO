import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

const MAX_BODY_BYTES = 65_536;
const DENIED = 'OAuth probe egress denied';

/** Conservative public-address policy; IPv4 translations/tunnels are excluded. */
export function isPublicOAuthAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [first, second = '0'] = canonical.split(':');
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
    && a !== 0x2002 && !(a === 0x3fff && b < 0x1000);
}

export function publicOAuthUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error(DENIED);
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')
      || url.username || url.password || url.search || url.hash || hostname.endsWith('.')
      || hostname === 'localhost' || /\.(localhost|local|internal|lan|home|invalid|test)$/.test(hostname)
      || (!isIP(hostname) && (!hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname)))
      || (isIP(hostname) && !isPublicOAuthAddress(hostname))) throw new Error(DENIED);
  return url;
}

async function resolveEndpoint(value: string, signal: AbortSignal): Promise<{ url: URL; hostname: string; address: string; family: 4 | 6 }> {
  signal.throwIfAborted();
  const url = publicOAuthUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) return { url, hostname, address: hostname, family: literalFamily };
  const records = await new Promise<LookupAddress[]>((resolve, reject) => {
    const onAbort = () => reject(new Error(DENIED));
    signal.addEventListener('abort', onAbort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
  signal.throwIfAborted();
  if (!records.length || records.length > 32 || records.some(record =>
    !isPublicOAuthAddress(record.address) || isIP(record.address) !== record.family)) throw new Error(DENIED);
  const selected = records[0];
  if (selected.family !== 4 && selected.family !== 6) throw new Error(DENIED);
  return { url, hostname, address: selected.address, family: selected.family };
}

/** Validate an advertised link before returning it; network requests resolve again. */
export async function publicOAuthEndpoint(value: string, signal: AbortSignal): Promise<string> {
  await resolveEndpoint(value, signal);
  // Preserve the issuer's exact identifier, including its declared trailing slash.
  return value;
}

export interface PublicOAuthResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
}

/**
 * Fixed OAuth metadata/challenge requests only. Connect to the admitted numeric
 * address, preserving original Host/SNI/certificate identity. No second lookup,
 * proxy, redirect, shared connection pool, cookies or caller auth headers.
 */
export async function requestPublicOAuth(value: string, kind: 'challenge' | 'metadata', signal: AbortSignal): Promise<PublicOAuthResponse> {
  try {
    const endpoint = await resolveEndpoint(value, signal);
    signal.throwIfAborted();
    return await new Promise<PublicOAuthResponse>((resolve, reject) => {
      const body = kind === 'challenge' ? JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) : undefined;
      const req = request({
        protocol: 'https:', hostname: endpoint.address, port: 443, family: endpoint.family,
        servername: isIP(endpoint.hostname) ? '' : endpoint.hostname,
        checkServerIdentity: (_host, cert) => checkServerIdentity(endpoint.hostname, cert),
        rejectUnauthorized: true, agent: false, signal, maxHeaderSize: 16_384,
        path: endpoint.url.pathname, method: kind === 'challenge' ? 'POST' : 'GET',
        headers: { host: endpoint.url.host, accept: kind === 'challenge' ? 'application/json, text/event-stream' : 'application/json',
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      }, res => {
        const status = res.statusCode ?? 0;
        const headers = new Headers();
        const authenticate = res.headers['www-authenticate'];
        if (typeof authenticate === 'string') headers.set('www-authenticate', authenticate);
        const respond = (content: Buffer) => resolve({ ok: status >= 200 && status < 300, status, headers,
          json: async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) });
        // Redirects are never followed. Challenge probing needs only headers,
        // including for an unbounded SSE response; destroy its owned socket.
        if (kind === 'challenge' || status < 200 || status >= 300) {
          respond(Buffer.alloc(0));
          res.destroy();
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy(); reject(new Error(DENIED)); return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { res.destroy(); reject(new Error(DENIED)); }
          else chunks.push(chunk);
        });
        res.on('end', () => { if (size <= MAX_BODY_BYTES) respond(Buffer.concat(chunks)); });
        res.on('error', () => reject(new Error(DENIED)));
        res.on('aborted', () => reject(new Error(DENIED)));
      });
      req.on('error', () => reject(new Error(DENIED)));
      req.end(body);
    });
  } catch { throw new Error(DENIED); }
}
