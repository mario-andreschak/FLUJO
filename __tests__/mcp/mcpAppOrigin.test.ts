/**
 * MCP Apps (#362/#387) — per-app origin key derivation.
 *
 * `deriveOriginKey()` picks a DNS-safe label used both to allocate a per-app
 * sandbox listener/token (backend) and to build the `{app}` hostname label a
 * hosted deployment substitutes into the sandbox public URL template
 * (frontend). Backend and frontend MUST derive the identical key from the
 * identical inputs, and the key must never be something that could break out
 * of a single DNS label (SSRF / open-proxy guard for the hostname matcher
 * that later consumes this value).
 */
import { deriveOriginKey, isValidMcpAppDomain, MAX_SANDBOX_ORIGINS } from '@/shared/utils/mcpAppOrigin';

describe('isValidMcpAppDomain', () => {
  it('accepts simple lowercase DNS-safe domains and labels', () => {
    expect(isValidMcpAppDomain('example.com')).toBe(true);
    expect(isValidMcpAppDomain('my-app')).toBe(true);
    expect(isValidMcpAppDomain('a1-b2.example-app.com')).toBe(true);
  });

  it('rejects non-string, empty, and over-length input', () => {
    expect(isValidMcpAppDomain(undefined)).toBe(false);
    expect(isValidMcpAppDomain(null)).toBe(false);
    expect(isValidMcpAppDomain(123 as unknown)).toBe(false);
    expect(isValidMcpAppDomain('')).toBe(false);
    expect(isValidMcpAppDomain('a'.repeat(254))).toBe(false);
  });

  it('rejects uppercase and non-ASCII', () => {
    expect(isValidMcpAppDomain('Example.com')).toBe(false);
    expect(isValidMcpAppDomain('exämple.com')).toBe(false);
  });

  it('rejects IPv4 and IPv6 literals', () => {
    expect(isValidMcpAppDomain('127.0.0.1')).toBe(false);
    expect(isValidMcpAppDomain('192.168.0.1')).toBe(false);
    expect(isValidMcpAppDomain('::1')).toBe(false);
    expect(isValidMcpAppDomain('2001:db8::1')).toBe(false);
  });

  it('rejects ports, paths, queries, fragments, and credentials', () => {
    expect(isValidMcpAppDomain('example.com:8080')).toBe(false);
    expect(isValidMcpAppDomain('example.com/path')).toBe(false);
    expect(isValidMcpAppDomain('example.com?x=1')).toBe(false);
    expect(isValidMcpAppDomain('example.com#frag')).toBe(false);
    expect(isValidMcpAppDomain('user@example.com')).toBe(false);
  });

  it('rejects malformed labels (empty, too long, leading/trailing hyphen)', () => {
    expect(isValidMcpAppDomain('a..b')).toBe(false);
    expect(isValidMcpAppDomain('.example.com')).toBe(false);
    expect(isValidMcpAppDomain('example.com.')).toBe(false);
    expect(isValidMcpAppDomain('-example.com')).toBe(false);
    expect(isValidMcpAppDomain('example-.com')).toBe(false);
    expect(isValidMcpAppDomain(`${'a'.repeat(64)}.com`)).toBe(false);
  });

  it('rejects injection-style payloads sometimes seen in server-declared metadata', () => {
    expect(isValidMcpAppDomain('example.com; rm -rf /')).toBe(false);
    expect(isValidMcpAppDomain('example.com\nEvil-Header: 1')).toBe(false);
    expect(isValidMcpAppDomain('javascript:alert(1)')).toBe(false);
  });
});

describe('deriveOriginKey', () => {
  it('prefers a valid declared domain over the hash fallback', () => {
    const key = deriveOriginKey({ domain: 'my-app.example.com', serverName: 'srv', uri: 'ui://a' });
    expect(key).toBe('my-app.example.com');
  });

  it('falls back to a deterministic DNS-safe hash when domain is missing or invalid', () => {
    const key1 = deriveOriginKey({ domain: undefined, serverName: 'srv', uri: 'ui://a' });
    const key2 = deriveOriginKey({ domain: undefined, serverName: 'srv', uri: 'ui://a' });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^app[0-9a-z]+$/);

    const bad = deriveOriginKey({ domain: 'not a domain!', serverName: 'srv', uri: 'ui://a' });
    expect(bad).toMatch(/^app[0-9a-z]+$/);
  });

  it('produces different keys for different serverName/uri combinations', () => {
    const a = deriveOriginKey({ serverName: 'srv-a', uri: 'ui://a' });
    const b = deriveOriginKey({ serverName: 'srv-b', uri: 'ui://a' });
    const c = deriveOriginKey({ serverName: 'srv-a', uri: 'ui://b' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('never returns a value that isMcpAppDomain-style label validation would reject', () => {
    // Every derived key must itself be safe to use as (or embed as) a single
    // DNS label in a hostname template — this is what the sandbox listener's
    // Host-header matching and the hosted proxy's origin matching rely on.
    const inputs = [
      { serverName: 'srv', uri: 'ui://weird?query=1&x=2' },
      { serverName: 'srv; rm -rf', uri: 'ui://a' },
      { domain: 'EXAMPLE.COM', serverName: 'srv', uri: 'ui://a' },
    ];
    for (const input of inputs) {
      const key = deriveOriginKey(input);
      expect(key).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });

  it('exposes a sane pool cap for Mode A port allocation', () => {
    expect(MAX_SANDBOX_ORIGINS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_SANDBOX_ORIGINS)).toBe(true);
  });
});
