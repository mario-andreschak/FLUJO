function endpointIdentity(value: string | undefined): string | undefined {
  try {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) return undefined;
    // The catalogue builder makes one optional trailing slash equivalent.
    // Preserve additional slashes; they can select a different server route.
    if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1) || '/';
    return url.href;
  } catch { return undefined; }
}

/** Stored credentials may be reused only for the saved catalogue endpoint. */
export function sameCatalogueEndpoint(stored: string | undefined, requested: string): boolean {
  const saved = endpointIdentity(stored);
  return saved !== undefined && saved === endpointIdentity(requested);
}
