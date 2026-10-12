/** Canonical registry base address, including its path prefix. */
export function canonicalRegistryBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username || url.password || url.search || url.hash) return null;
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function requireRegistryBaseUrl(value: unknown): string {
  const baseUrl = canonicalRegistryBaseUrl(value);
  if (!baseUrl) throw new Error('Registry URL must be an absolute http(s) base URL without credentials, query, or fragment.');
  return baseUrl;
}

export function isSameRegistryDestination(issuer: unknown, selected: string): boolean {
  const bound = canonicalRegistryBaseUrl(issuer);
  return bound !== null && bound === canonicalRegistryBaseUrl(selected);
}
