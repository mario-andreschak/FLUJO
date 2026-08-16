import { isValidMcpAppDomain } from '@/shared/utils/mcpAppOrigin';

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
    expect(isValidMcpAppDomain(' example.com ')).toBe(false);
    expect(isValidMcpAppDomain('a'.repeat(254))).toBe(false);
  });

  it('rejects uppercase, non-ASCII, and IP literals', () => {
    expect(isValidMcpAppDomain('Example.com')).toBe(false);
    expect(isValidMcpAppDomain('exämple.com')).toBe(false);
    expect(isValidMcpAppDomain('127.0.0.1')).toBe(false);
    expect(isValidMcpAppDomain('192.168.0.1')).toBe(false);
    expect(isValidMcpAppDomain('::1')).toBe(false);
    expect(isValidMcpAppDomain('2001:db8::1')).toBe(false);
  });

  it('rejects ports, paths, queries, fragments, credentials, and malformed labels', () => {
    expect(isValidMcpAppDomain('example.com:8080')).toBe(false);
    expect(isValidMcpAppDomain('example.com/path')).toBe(false);
    expect(isValidMcpAppDomain('example.com?x=1')).toBe(false);
    expect(isValidMcpAppDomain('example.com#frag')).toBe(false);
    expect(isValidMcpAppDomain('user@example.com')).toBe(false);
    expect(isValidMcpAppDomain('a..b')).toBe(false);
    expect(isValidMcpAppDomain('.example.com')).toBe(false);
    expect(isValidMcpAppDomain('example.com.')).toBe(false);
    expect(isValidMcpAppDomain('-example.com')).toBe(false);
    expect(isValidMcpAppDomain('example-.com')).toBe(false);
    expect(isValidMcpAppDomain(`${'a'.repeat(64)}.com`)).toBe(false);
  });

  it('rejects injection-style payloads', () => {
    expect(isValidMcpAppDomain('example.com; rm -rf /')).toBe(false);
    expect(isValidMcpAppDomain('example.com\nEvil-Header: 1')).toBe(false);
    expect(isValidMcpAppDomain('javascript:alert(1)')).toBe(false);
  });
});
