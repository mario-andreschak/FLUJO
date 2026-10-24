import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Runtime } from './config.js';
import { cookie } from './http.js';

export const APP_SESSION_COOKIE = '__Host-flujo-app';

const keyPattern = /^app[a-f0-9]{60}$/;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
interface Launch {
  runtime: Runtime; origin: string; token: string; expiresAt: number; deadline: number; current: () => boolean;
  appSession?: AppSession;
}
interface AppSession {
  runtime: Runtime; origin: string; parentHash: string; token: string;
  expiresAt: number; deadline: number; current: () => boolean;
}

export function appRequestPath(target: string): string | undefined {
  if (target.length > 16_384 || !target.startsWith('/') || target.startsWith('//')
      || /[\\\x00-\x20\x7f]/.test(target) || /%(?:2f|5c|00)/i.test(target.split('?')[0])) return undefined;
  try {
    const url = new URL(target, 'https://localhost');
    if (url.pathname !== target.split('?')[0] || url.hash) return undefined;
    return url.pathname;
  } catch { return undefined; }
}

const sidecarPath = (target: string): boolean => {
  const path = appRequestPath(target);
  return !!path && path !== '/' && path !== '/sandbox.html' && !path.startsWith('/_flujo')
    && !path.startsWith('/.well-known/flujo');
};

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
  private readonly sessions = new Map<string, AppSession>();

  issue(runtime: Runtime, value: unknown, current: () => boolean,
    parent?: { hash: string; expiresAt: number }): unknown {
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
    let appSession: AppSession | undefined;
    if (parent) {
      if (!/^[a-f0-9]{64}$/.test(parent.hash) || !Number.isSafeInteger(parent.expiresAt)
          || parent.expiresAt <= now || parent.expiresAt > now + 28_800_000) throw new Error('Invalid parent session.');
      for (const [id, session] of this.sessions) {
        if (!this.sessionCurrent(session)) this.sessions.delete(id);
      }
      appSession = [...this.sessions.values()].find(session => session.origin === origin && session.parentHash === parent.hash);
      if (!appSession) {
        if (this.sessions.size >= 4096 || [...this.sessions.values()].filter(session => session.runtime.id === runtime.id).length >= 64) {
          throw new Error('Too many active app sessions.');
        }
        appSession = { runtime, origin, parentHash: parent.hash, expiresAt: parent.expiresAt,
          deadline: performance.now() + parent.expiresAt - now, current, token: randomBytes(32).toString('base64url') };
        this.sessions.set(hash(appSession.token), appSession);
      }
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + 60_000;
    this.launches.set(hash(token), { runtime, origin, token: data.token, expiresAt, deadline: performance.now() + 60_000, current, appSession });
    return { url: `${origin}/sandbox.html`, token, originKey: data.originKey, shared: false, allowAll: false,
      expiresAt, reusable: false };
  }

  admit(request: IncomingMessage): (Launch & { path: string; cookie?: string }) | undefined {
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
    const session = launch.appSession;
    return { ...launch, path: `${url.pathname}${url.search}`,
      ...(session ? { cookie: `${APP_SESSION_COOKIE}=${session.token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}` } : {}) };
  }

  private sessionCurrent(session: AppSession): boolean {
    try { return session.expiresAt > Date.now() && session.deadline > performance.now() && session.current(); }
    catch { return false; }
  }

  /** This cookie grants only registered routes on the fixed sandbox listener.
   * Same-site sibling apps are explicitly refused; cookie attributes alone are
   * not the CSRF boundary. Browser WebSockets must supply this exact Origin. */
  sidecar(request: IncomingMessage, websocket = false): (AppSession & { path: string }) | undefined {
    if (request.headers['sec-fetch-dest'] === 'serviceworker' || request.headers['service-worker'] !== undefined
        || !sidecarPath(request.url ?? '') || request.headers['sec-fetch-site'] !== 'same-origin'
        && !(websocket && request.headers['sec-fetch-site'] === undefined)) return undefined;
    const token = cookie(request, APP_SESSION_COOKIE);
    const id = hash(token); const session = this.sessions.get(id);
    if (!session || request.headers.host !== new URL(session.origin).host
        || request.headers.origin !== undefined && request.headers.origin !== session.origin
        || (websocket || !['GET', 'HEAD'].includes(request.method ?? '')) && request.headers.origin !== session.origin) return undefined;
    if (!this.sessionCurrent(session)) { this.sessions.delete(id); return undefined; }
    return { ...session, path: request.url!, current: () => this.sessions.get(id) === session && this.sessionCurrent(session) };
  }
}
