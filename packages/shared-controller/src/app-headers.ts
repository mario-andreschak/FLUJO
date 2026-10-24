import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';

const cookieName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const protectedCookie = (name: string) => name.toLowerCase().startsWith('__host-flujo-');

/** Preserve sidecar-owned cookies, never controller or sibling-domain cookies. */
export function appResponseCookies(values: string[] | undefined): string[] {
  return (values ?? []).filter(value => {
    const parts = value.split(';'); const name = parts[0].slice(0, parts[0].indexOf('='));
    return parts[0].indexOf('=') > 0 && value.length <= 4096 && !/[\r\n\0]/.test(value) && cookieName.test(name) && !protectedCookie(name)
      && !parts.slice(1).some(part => /^\s*domain(?:\s*=|\s*$)/i.test(part));
  }).map(value => /;\s*secure(?:\s*;|\s*$)/i.test(value) ? value : `${value}; Secure`);
}

export function appRequestHeaders(request: IncomingMessage, origin: string): OutgoingHttpHeaders {
  const allowed = new Set(['accept', 'accept-language', 'accept-encoding', 'authorization', 'content-type', 'content-length',
    'range', 'if-range', 'if-none-match', 'if-modified-since', 'cache-control', 'origin',
    'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']);
  const connection = new Set((request.headers.connection ?? '').toLowerCase().split(',').map(part => part.trim()));
  const headers: OutgoingHttpHeaders = Object.fromEntries(Object.entries(request.headers)
    .filter(([name]) => allowed.has(name) && !connection.has(name)));
  const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => {
    const name = part.slice(0, part.indexOf('='));
    return part.indexOf('=') > 0 && cookieName.test(name) && !protectedCookie(name);
  });
  if (cookies.length && !connection.has('cookie')) headers.cookie = cookies.join('; ');
  const publicUrl = new URL(origin);
  headers.host = publicUrl.host;
  // Presentation only, replaced after filtering caller forwarding headers.
  headers['x-forwarded-host'] = publicUrl.host;
  headers['x-forwarded-proto'] = publicUrl.protocol.slice(0, -1);
  headers['x-forwarded-port'] = publicUrl.port || '443';
  return headers;
}

export function appFramePolicy(policy: string | string[] | undefined, owner: string, app: string): string {
  // Multiple CSP headers/policies intersect. Keep each content policy and
  // replace only its ancestor list so the exact owner -> app -> sidecar chain works.
  return (Array.isArray(policy) ? policy : [policy ?? '']).flatMap(value => value.split(',')).map(value => {
    const content = value.split(';').filter(directive => !/^\s*frame-ancestors(?:\s|$)/i.test(directive)).join(';');
    return `${content}; frame-ancestors ${owner} ${app}`;
  }).join(', ');
}
