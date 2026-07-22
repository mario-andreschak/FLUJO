/**
 * MCP Apps (#97) Phase 2 — the sandbox origin's HTTP CSP header builder.
 *
 * The sandbox document runs on a throwaway foreign origin, so `'self'` there is
 * NOT FLUJO. The header must default-deny network egress and reject any
 * server-declared CSP token that could break out of its directive.
 */
import { buildSandboxCsp } from '@/backend/mcpApps/sandboxServer';

describe('buildSandboxCsp', () => {
  it('defaults to no network egress and blocks framing/base/object', () => {
    const csp = buildSandboxCsp(undefined);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/connect-src[^;]*https?:/); // no external hosts by default
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("default-src 'self' 'unsafe-inline'");
  });

  it('widens only the mapped directive from declared domains', () => {
    const csp = buildSandboxCsp({
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(csp).toMatch(/connect-src 'self' https:\/\/api\.example\.com/);
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.example\.com/);
    expect(csp).toMatch(/frame-src https:\/\/embed\.example\.com/);
    expect(csp).toMatch(/base-uri https:\/\/base\.example\.com/);
    // A resource domain must not leak into connect-src.
    expect(csp).not.toMatch(/connect-src[^;]*cdn\.example\.com/);
  });

  it('drops injection payloads (semicolons, quotes, spaces) rather than emitting them', () => {
    const csp = buildSandboxCsp({
      connectDomains: [
        "https://ok.example.com",
        "https://evil.com; script-src 'unsafe-eval'", // directive break-out
        "https://a.com b.com",                          // space-separated smuggle
        "'unsafe-inline'",                              // quoted keyword
        'https://x.com\n; default-src *',               // newline break-out
      ],
    });
    expect(csp).toContain('https://ok.example.com');
    expect(csp).not.toContain('evil.com'); // directive break-out payload dropped whole
    expect(csp).not.toContain('b.com');
    expect(csp).not.toContain('default-src *');
    // The injected tokens must not have widened connect-src with a keyword/host.
    expect(csp).not.toMatch(/connect-src[^;]*unsafe/);
    expect(csp).not.toMatch(/connect-src[^;]*x\.com/);
  });
});
