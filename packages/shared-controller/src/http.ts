import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE = '__Host-flujo-controller';
export const LOGIN_COOKIE = '__Host-flujo-login';

export function cookie(request: IncomingMessage, name: string): string {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`)).map(value => value.slice(name.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]) ? values[0] : '';
}

export function sessionCookie(name: string, value: string, seconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

export function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

export function reply(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  securityHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: message }));
}

export function redirect(response: ServerResponse, location: string): void {
  securityHeaders(response);
  response.writeHead(303, { Location: location });
  response.end();
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function accountPage(response: ServerResponse, signedIn: boolean): void {
  securityHeaders(response);
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const title = signedIn ? 'Your FLUJO account' : 'Sign in to FLUJO';
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font:17px system-ui}body{margin:0;display:grid;min-height:100dvh;place-items:center;background:#101318;color:#edf1f7}main{box-sizing:border-box;width:min(100%,34rem);padding:2rem}h1{font-size:2rem;line-height:1.15}p{line-height:1.6;color:#bfc8d5}button,a{font:inherit}button{padding:.8rem 1.2rem;border:0;border-radius:.5rem;background:#9ce4ca;color:#10241e;cursor:pointer}a{color:#9ce4ca}form{margin:1.5rem 0}button:focus-visible,a:focus-visible{outline:3px solid white;outline-offset:5px}
  </style></head><body><main><h1>${escapeHtml(title)}</h1><p>${signedIn
    ? 'You are signed in to your private FLUJO. Signing out ends this browser session. Your scheduled work continues in your runtime.'
    : 'Use your organization’s identity provider to open your private FLUJO. Access is assigned by your administrator.'}</p>
  <form method="post" action="/_account/${signedIn ? 'logout' : 'login'}"><button>${signedIn ? 'Sign out' : 'Sign in'}</button></form>
  ${signedIn ? '<a href="/">Back to FLUJO</a>' : ''}</main></body></html>`);
}

/** Exact origin even for same-site sibling hosts. Forwarded headers grant nothing. */
export function browserRequestAllowed(request: IncomingMessage, origin: string): boolean {
  const supplied = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (supplied !== undefined && supplied !== origin) return false;
  if (site === 'cross-site' || site === 'same-site') return false;
  return ['GET', 'HEAD'].includes(request.method ?? '') || supplied === origin;
}
