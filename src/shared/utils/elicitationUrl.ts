/**
 * Checks the link an MCP server asks the person to open (URL-mode elicitation).
 *
 * The same rules run on the server, before FLUJO shows the request, and in the
 * browser, before the link opens. A link must be a plain web address: HTTPS,
 * or HTTP on this computer only. Links that hide their real host behind a user
 * name (`https://bank.example@evil.example`) are refused, and hosts written in
 * Punycode are flagged so the card can warn about look-alike names.
 */
export const MAX_ELICITATION_URL_LENGTH = 4096;

export interface VettedElicitationUrl {
  href: string;
  /** Host name the browser will contact, shown highlighted on the card. */
  host: string;
  /** True when a host label is Punycode (`xn--`), which can imitate another name. */
  lookalikeHost: boolean;
  /** True for a plain-HTTP link to this computer. */
  insecureLocal: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/** Returns the checked link, or `undefined` when FLUJO must not offer it. */
export function vetElicitationUrl(raw: unknown): VettedElicitationUrl | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_ELICITATION_URL_LENGTH) return undefined;
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return undefined;
  const local = isLocalHost(hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return undefined;
  return {
    href: url.href,
    host: url.host.toLowerCase(),
    lookalikeHost: hostname.split('.').some((label) => label.startsWith('xn--')),
    insecureLocal: url.protocol === 'http:',
  };
}
