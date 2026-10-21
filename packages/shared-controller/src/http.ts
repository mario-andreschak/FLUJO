import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE = '__Host-flujo-controller';

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

export function accountPage(response: ServerResponse, signedIn: boolean, error = '', status = 200): void {
  securityHeaders(response);
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  const title = signedIn ? 'Your FLUJO account' : 'Sign in to FLUJO';
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:light dark;font:17px system-ui}body{margin:0;display:grid;min-height:100dvh;place-items:center;background:#101318;color:#edf1f7}main{box-sizing:border-box;width:min(100%,34rem);padding:2rem}h1{font-size:2rem;line-height:1.15}p{line-height:1.6;color:#bfc8d5}button,a{font:inherit}button{padding:.8rem 1.2rem;border:0;border-radius:.5rem;background:#9ce4ca;color:#10241e;cursor:pointer}a{color:#9ce4ca}form{margin:1.5rem 0}button:focus-visible,a:focus-visible{outline:3px solid white;outline-offset:5px}
  </style></head><body><main><h1>${escapeHtml(title)}</h1><p>${signedIn
    ? 'You are signed in to your private FLUJO. Signing out ends this browser session. Your scheduled work continues in your runtime.'
    : 'Sign in with your local FLUJO password. Your installation administrator manages account access and password recovery.'}</p>
  ${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/_account/${signedIn ? 'logout' : 'login'}">
  ${signedIn ? '' : '<label for="password">Password</label><input style="display:block;box-sizing:border-box;width:100%;margin:.5rem 0 1rem;padding:.8rem;font:inherit" id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" aria-describedby="password-help"><p id="password-help">This account works without an internet connection.</p>'}
  <button>${signedIn ? 'Sign out' : 'Sign in'}</button></form>
  ${signedIn ? '<a href="/">Back to FLUJO</a>' : ''}</main></body></html>`);
}

/** Small, time-bounded local login form. No JSON, duplicate fields, query-string
 * passwords or decoder replacement of invalid UTF-8. */
export async function readPasswordForm(request: IncomingMessage): Promise<string | null> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
      || request.headers['content-encoding'] !== undefined) return null;
  const chunks: Buffer[] = [];
  return new Promise(resolve => {
    let size = 0;
    let done = false;
    const finish = (password: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.off('data', data); request.off('end', end);
      request.off('aborted', aborted); request.off('error', aborted);
      for (const chunk of chunks) chunk.fill(0);
      resolve(password);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { finish(null); request.resume(); }
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      const bytes = Buffer.concat(chunks);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        // decodeURIComponent rejects malformed percent escapes and encoded UTF-8.
        const pairs = text.split('&').map(pair => {
          const at = pair.indexOf('=');
          if (at < 0) throw new Error('Invalid form.');
          return [decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' ')),
            decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '))];
        });
        finish(pairs.length === 1 && pairs[0][0] === 'password' ? pairs[0][1] : null);
      } catch { finish(null); }
      finally { bytes.fill(0); }
    };
    const aborted = () => finish(null);
    const timer = setTimeout(() => { finish(null); request.resume(); }, 10_000);
    request.on('data', data); request.once('end', end);
    request.once('aborted', aborted); request.once('error', aborted);
  });
}

/** Exact origin even for same-site sibling hosts. Forwarded headers grant nothing. */
export function browserRequestAllowed(request: IncomingMessage, origin: string): boolean {
  const supplied = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (supplied !== undefined && supplied !== origin) return false;
  if (site === 'cross-site' || site === 'same-site') return false;
  return ['GET', 'HEAD'].includes(request.method ?? '') || supplied === origin;
}
