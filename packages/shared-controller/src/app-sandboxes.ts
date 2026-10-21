import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Runtime } from './config.js';

const keyPattern = /^app[a-f0-9]{60}$/;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
interface Launch {
  runtime: Runtime; origin: string; token: string; expiresAt: number; deadline: number; current: () => boolean;
}

export function appSandboxOrigin(runtime: Runtime, originKey: string): string {
  if (!keyPattern.test(originKey)) throw new Error('Invalid app identity.');
  const owner = new URL(runtime.origin);
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(owner.hostname)) throw new Error('Local app origin required.');
  owner.hostname = `${originKey}.${owner.hostname}`;
  return owner.origin;
}

/** One-use launch authority. Never expose runtime credentials or accept a
 * browser-selected transport. Restart drops all tickets; logout/account/runtime
 * revocation is checked against the owning session again at admission/response. */
export class AppSandboxes {
  private readonly launches = new Map<string, Launch>();

  issue(runtime: Runtime, value: unknown, current: () => boolean): unknown {
    const data = value as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || !keyPattern.test(String(data.originKey))
        || typeof data.token !== 'string' || !ticketPattern.test(data.token)
        || data.shared !== false || data.allowAll !== false || data.port !== 4201) {
      throw new Error('Invalid private sandbox discovery.');
    }
    const origin = appSandboxOrigin(runtime, String(data.originKey));
    if (data.url !== `${origin}/sandbox.html`) throw new Error('Invalid private sandbox origin.');
    const now = Date.now();
    for (const [id, launch] of this.launches) {
      if (launch.expiresAt <= now || launch.deadline <= performance.now() || !launch.current()) this.launches.delete(id);
    }
    if (!current() || this.launches.size >= 4096
        || [...this.launches.values()].filter(launch => launch.runtime.id === runtime.id).length >= 64) {
      throw new Error('Sandbox launch is unavailable.');
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + 60_000;
    this.launches.set(hash(token), { runtime, origin, token: data.token, expiresAt, deadline: performance.now() + 60_000, current });
    return { url: `${origin}/sandbox.html`, token, originKey: data.originKey, shared: false, allowAll: false,
      expiresAt, reusable: false };
  }

  admit(request: IncomingMessage): (Launch & { path: string }) | undefined {
    if (request.method !== 'GET' || !request.url || request.url.length > 16_384
        || request.headers['content-length'] && request.headers['content-length'] !== '0'
        || request.headers['transfer-encoding'] !== undefined) return undefined;
    const url = new URL(request.url, 'https://localhost');
    if (url.pathname !== '/sandbox.html' || request.url.split('?')[0] !== '/sandbox.html'
        || [...url.searchParams.keys()].some(key => !['token', 'csp'].includes(key))
        || url.searchParams.getAll('token').length !== 1 || url.searchParams.getAll('csp').length > 1) return undefined;
    const token = url.searchParams.get('token') ?? '';
    if (!ticketPattern.test(token)) return undefined;
    const id = hash(token); const launch = this.launches.get(id);
    if (!launch || request.headers.host !== new URL(launch.origin).host
        || request.headers.referer !== `${launch.runtime.origin}/`
        || request.headers.origin !== undefined && request.headers.origin !== launch.runtime.origin
        || request.headers['sec-fetch-dest'] !== 'iframe'
        || request.headers['sec-fetch-mode'] !== 'navigate') return undefined;
    this.launches.delete(id);
    if (launch.expiresAt <= Date.now() || launch.deadline <= performance.now() || !launch.current()) return undefined;
    url.searchParams.set('token', launch.token);
    return { ...launch, path: `${url.pathname}${url.search}` };
  }
}
