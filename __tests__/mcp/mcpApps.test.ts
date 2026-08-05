import {
  UI_RESOURCE_SCHEME,
  MCP_APP_IFRAME_SANDBOX,
  MAX_UI_RESOURCE_BYTES,
  isUiResourceUri,
  isMcpAppMimeType,
  extractUiResourceUri,
  buildAppCsp,
  buildAppSrcDoc,
  extractAppHtml,
  isLoopbackCspOrigin,
  isValidCspSourceToken,
} from '@/shared/utils/mcpApps';

// MCP Apps (SEP-1865, #97) — pure helpers for Phase 1 read-only rendering.

describe('isUiResourceUri', () => {
  it('accepts ui:// URIs with a case-insensitive scheme', () => {
    expect(isUiResourceUri('ui://weather-dashboard')).toBe(true);
    expect(isUiResourceUri('UI://Thing')).toBe(true);
  });

  it('rejects malformed/non-ui schemes and non-strings', () => {
    expect(isUiResourceUri('  ui://x')).toBe(false);
    expect(isUiResourceUri('ui://')).toBe(false);
    expect(isUiResourceUri('ui://has space')).toBe(false);
    expect(isUiResourceUri('ui://x\n')).toBe(false);
    expect(isUiResourceUri('https://example.com')).toBe(false);
    expect(isUiResourceUri('file:///tmp/x')).toBe(false);
    expect(isUiResourceUri(undefined)).toBe(false);
    expect(isUiResourceUri(42)).toBe(false);
    expect(isUiResourceUri('')).toBe(false);
  });
});

describe('isMcpAppMimeType', () => {
  it('matches text/html with the mcp-app profile, ignoring whitespace/charset', () => {
    expect(isMcpAppMimeType('text/html;profile=mcp-app')).toBe(true);
    expect(isMcpAppMimeType('text/html; profile=mcp-app')).toBe(true);
    expect(isMcpAppMimeType('text/html; charset=utf-8; profile=mcp-app')).toBe(true);
    expect(isMcpAppMimeType('TEXT/HTML;PROFILE=MCP-APP')).toBe(true);
  });

  it('rejects plain html and other types', () => {
    expect(isMcpAppMimeType('text/html')).toBe(false);
    expect(isMcpAppMimeType('text/htmlish;profile=mcp-app')).toBe(false);
    expect(isMcpAppMimeType('text/html;profile=mcp-app-extra')).toBe(false);
    expect(isMcpAppMimeType('text/html;profile=mcp-app;profile=other')).toBe(false);
    expect(isMcpAppMimeType('text/html;profile=mcp-app;broken')).toBe(false);
    expect(isMcpAppMimeType('application/json')).toBe(false);
    expect(isMcpAppMimeType(undefined)).toBe(false);
  });
});

describe('extractUiResourceUri', () => {
  it('reads _meta.ui.resourceUri (SEP-1865)', () => {
    expect(extractUiResourceUri({ ui: { resourceUri: 'ui://dash' } })).toBe('ui://dash');
  });

  it('reads the fully-qualified io.modelcontextprotocol/ui key', () => {
    expect(
      extractUiResourceUri({ 'io.modelcontextprotocol/ui': { resourceUri: 'ui://x' } })
    ).toBe('ui://x');
  });

  it('reads the stable specification’s deprecated flat ui/resourceUri key', () => {
    expect(extractUiResourceUri({ 'ui/resourceUri': 'ui://legacy' })).toBe('ui://legacy');
  });

  it('ignores links that are not ui:// URIs', () => {
    expect(extractUiResourceUri({ ui: { resourceUri: 'https://evil.example' } })).toBeUndefined();
    expect(extractUiResourceUri({ ui: {} })).toBeUndefined();
    expect(extractUiResourceUri({})).toBeUndefined();
    expect(extractUiResourceUri(null)).toBeUndefined();
    expect(extractUiResourceUri('not-an-object')).toBeUndefined();
  });
});

describe('buildAppCsp', () => {
  it('is default-deny when no domains are declared', () => {
    const csp = buildAppCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
    // inline is allowed so a self-contained srcdoc can run.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('blob:');
  });

  it('widens only the mapped directive per declared domain list', () => {
    const csp = buildAppCsp({
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://frame.example.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(csp).toContain('connect-src https://api.example.com');
    expect(csp).toContain('script-src \'self\' \'unsafe-inline\' https://cdn.example.com');
    expect(csp).toContain('frame-src https://frame.example.com');
    expect(csp).toContain('base-uri https://base.example.com');
    // connect-src must NOT have been widened by resourceDomains.
    expect(csp).not.toContain('connect-src https://cdn.example.com');
  });

  it('trims and drops empty entries', () => {
    const csp = buildAppCsp({ connectDomains: ['  https://a.com  ', '', '   '] });
    expect(csp).toContain('connect-src https://a.com');
  });

  it('neutralizes CSP directive injection via a malicious connect domain', () => {
    const csp = buildAppCsp({ connectDomains: ['example.com; frame-src *'] });
    // The malicious token is dropped, so connect-src collapses to the secure default.
    expect(csp).toContain("connect-src 'none'");
    // No injected/duplicated frame-src widening; frame-src stays default-deny.
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toContain('frame-src *');
    expect(csp).not.toContain('example.com');
    // Exactly one frame-src directive (no injected duplicate).
    expect(csp.match(/frame-src/g)).toHaveLength(1);
  });

  it('neutralizes a connect-src widening injection attempt', () => {
    const csp = buildAppCsp({ connectDomains: ['https://a.com; connect-src *'] });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('connect-src *');
    // Exactly one connect-src directive.
    expect(csp.match(/connect-src/g)).toHaveLength(1);
  });

  it('drops server-supplied CSP keywords and wildcard sources', () => {
    const csp = buildAppCsp({
      connectDomains: ["'unsafe-inline'", 'data:', 'blob:', '*', "'unsafe-eval'"],
    });
    expect(csp).toContain("connect-src 'none'");
  });

  it('rejects http/ws and credentialed/path URLs, keeping the boundary strict', () => {
    const csp = buildAppCsp({
      connectDomains: [
        'http://insecure.example.com',
        'ws://insecure.example.com',
        'https://user:pass@example.com',
        'https://example.com/path',
      ],
    });
    expect(csp).toContain("connect-src 'none'");
  });

  it('accepts a valid https wildcard subdomain across resource directives', () => {
    const csp = buildAppCsp({ resourceDomains: ['https://*.cdn.example.com'] });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://*.cdn.example.com");
    expect(csp).toContain("img-src 'self' data: https://*.cdn.example.com");
  });

  it('accepts a wss connect domain with a port', () => {
    const csp = buildAppCsp({ connectDomains: ['wss://realtime.example.com:8443'] });
    expect(csp).toContain('connect-src wss://realtime.example.com:8443');
  });

  it('admits loopback http/ws origins only with the explicit allowLoopback opt-in', () => {
    const meta = {
      connectDomains: ['http://127.0.0.1:59503', 'ws://127.0.0.1:59503'],
      frameDomains: ['http://127.0.0.1:59503'],
      resourceDomains: ['http://localhost:59503'],
    };
    const strict = buildAppCsp(meta);
    expect(strict).toContain("connect-src 'none'");
    expect(strict).toContain("frame-src 'none'");
    expect(strict).not.toContain('127.0.0.1');

    const loopback = buildAppCsp(meta, { allowLoopback: true });
    expect(loopback).toContain('connect-src http://127.0.0.1:59503 ws://127.0.0.1:59503');
    expect(loopback).toContain('frame-src http://127.0.0.1:59503');
    expect(loopback).toMatch(/img-src[^;]*http:\/\/localhost:59503/);
  });

  it('keeps ws: out of non-connect directives and non-loopback http out entirely, even with allowLoopback', () => {
    const csp = buildAppCsp({
      frameDomains: ['ws://127.0.0.1:59503'],
      connectDomains: ['http://insecure.example.com', 'http://127.0.0.1'],
    }, { allowLoopback: true });
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });
});

describe('isLoopbackCspOrigin', () => {
  it('accepts explicit-port http/ws loopback origins', () => {
    expect(isLoopbackCspOrigin('http://127.0.0.1:59503')).toBe(true);
    expect(isLoopbackCspOrigin('ws://127.0.0.1:59503')).toBe(true);
    expect(isLoopbackCspOrigin('http://localhost:4300')).toBe(true);
    expect(isLoopbackCspOrigin('HTTP://LOCALHOST:4300')).toBe(true);
    expect(isLoopbackCspOrigin('http://[::1]:4300')).toBe(true);
  });

  it('honors the per-directive scheme restriction', () => {
    expect(isLoopbackCspOrigin('ws://127.0.0.1:59503', ['http'])).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1:59503', ['http'])).toBe(true);
  });

  it('rejects missing ports, non-loopback hosts, secure schemes, and injection payloads', () => {
    expect(isLoopbackCspOrigin('http://127.0.0.1')).toBe(false);
    expect(isLoopbackCspOrigin('http://localhost')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1:0')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1:99999')).toBe(false);
    expect(isLoopbackCspOrigin('http://insecure.example.com:80')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1.evil.test:80')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.2:80')).toBe(false);
    expect(isLoopbackCspOrigin('https://127.0.0.1:4300')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1:4300/path')).toBe(false);
    expect(isLoopbackCspOrigin('http://127.0.0.1:4300; frame-src *')).toBe(false);
    expect(isLoopbackCspOrigin('http://user:pass@127.0.0.1:4300')).toBe(false);
    expect(isLoopbackCspOrigin(undefined)).toBe(false);
    expect(isLoopbackCspOrigin(42 as unknown as string)).toBe(false);
  });
});

describe('buildAppSrcDoc', () => {
  it('injects the CSP meta right after an existing <head>', () => {
    const doc = buildAppSrcDoc('<html><head><title>x</title></head><body>hi</body></html>');
    expect(doc).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
    expect(doc).toContain('<title>x</title>');
    expect(doc).toContain('hi');
  });

  it('wraps bare HTML in a scaffold carrying the CSP', () => {
    const doc = buildAppSrcDoc('<div>hello</div>');
    expect(doc).toContain('<!DOCTYPE html>');
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain('<div>hello</div>');
  });

  it('inserts the CSP meta verbatim (no $-substitution) and preserves $ in <head> attributes', () => {
    // A <head> whose attributes contain regex-replacement specials ($&, $1, $$).
    // A string-based replacement could mangle these; the function replacer must
    // round-trip both the attributes and the (server-derived) CSP meta verbatim.
    const html = '<html><head data-token="$&$1$$">x</head></html>';
    const doc = buildAppSrcDoc(html);
    expect(doc).toContain('<head data-token="$&$1$$">');
    // The CSP meta appears exactly as buildAppCsp produced it.
    const expectedMeta = `<meta http-equiv="Content-Security-Policy" content="${buildAppCsp()}">`;
    expect(doc).toContain(expectedMeta);
  });
});

describe('isValidCspSourceToken', () => {
  it('accepts valid https/wss origins', () => {
    expect(isValidCspSourceToken('https://example.com')).toBe(true);
    expect(isValidCspSourceToken('https://*.cdn.example.com')).toBe(true);
    expect(isValidCspSourceToken('https://example.com:8443')).toBe(true);
    expect(isValidCspSourceToken('wss://realtime.example.com')).toBe(true);
  });

  it('rejects injection payloads, forbidden keywords, wildcards and weak schemes', () => {
    expect(isValidCspSourceToken('example.com; frame-src *')).toBe(false);
    expect(isValidCspSourceToken("'unsafe-inline'")).toBe(false);
    expect(isValidCspSourceToken("'self'")).toBe(false);
    expect(isValidCspSourceToken("'none'")).toBe(false);
    expect(isValidCspSourceToken('data:')).toBe(false);
    expect(isValidCspSourceToken('*')).toBe(false);
    expect(isValidCspSourceToken('https://*')).toBe(false);
    expect(isValidCspSourceToken('http://insecure.example.com')).toBe(false);
    expect(isValidCspSourceToken('ws://insecure.example.com')).toBe(false);
    expect(isValidCspSourceToken('https://user:pass@example.com')).toBe(false);
    expect(isValidCspSourceToken('https://example.com/path')).toBe(false);
    expect(isValidCspSourceToken('https://example.com$')).toBe(false);
    expect(isValidCspSourceToken('https://ex ample.com')).toBe(false);
    expect(isValidCspSourceToken('https://exa mple.com')).toBe(false);
    expect(isValidCspSourceToken(undefined)).toBe(false);
    expect(isValidCspSourceToken(42)).toBe(false);
  });

  it('accepts loopback http/ws origins only via the explicit opt-in', () => {
    expect(isValidCspSourceToken('http://127.0.0.1:59503')).toBe(false);
    expect(isValidCspSourceToken('http://127.0.0.1:59503', { allowLoopback: true })).toBe(true);
    expect(isValidCspSourceToken('ws://localhost:4300', { allowLoopback: true })).toBe(true);
    // Non-loopback and portless tokens stay rejected even with the opt-in.
    expect(isValidCspSourceToken('http://insecure.example.com', { allowLoopback: true })).toBe(false);
    expect(isValidCspSourceToken('http://127.0.0.1', { allowLoopback: true })).toBe(false);
  });
});

describe('extractAppHtml', () => {
  it('prefers the mcp-app HTML entry', () => {
    const result = extractAppHtml({
      contents: [
        { uri: 'ui://x', mimeType: 'application/json', text: '{"a":1}' },
        { uri: 'ui://x', mimeType: 'text/html;profile=mcp-app', text: '<h1>App</h1>' },
      ],
    });
    expect('html' in result && result.html).toBe('<h1>App</h1>');
  });

  it('rejects text that is not declared as MCP App HTML', () => {
    const result = extractAppHtml({ contents: [{ text: '<p>plain</p>' }] });
    expect('error' in result && result.error).toMatch(/no MCP App HTML body/);
  });

  it('surfaces the resource _meta.ui block', () => {
    const result = extractAppHtml({
      contents: [
        {
          mimeType: 'text/html;profile=mcp-app',
          text: '<h1>A</h1>',
          _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
        } as never,
      ],
    });
    expect('html' in result && result.meta?.csp?.connectDomains).toEqual(['https://api.example.com']);
  });

  it('decodes blob content and enforces the requested resource URI', () => {
    const encoded = Buffer.from('<h1>Blob app</h1>', 'utf8').toString('base64');
    const result = extractAppHtml({
      contents: [
        {
          uri: 'ui://expected',
          mimeType: 'text/html;profile=mcp-app',
          blob: encoded,
        },
      ],
    }, MAX_UI_RESOURCE_BYTES, 'ui://expected');
    expect('html' in result && result.html).toBe('<h1>Blob app</h1>');

    const mismatch = extractAppHtml({
      contents: [
        {
          uri: 'ui://different',
          mimeType: 'text/html;profile=mcp-app',
          text: '<h1>Wrong app</h1>',
        },
      ],
    }, MAX_UI_RESOURCE_BYTES, 'ui://expected');
    expect('error' in mismatch && mismatch.error).toMatch(/matching ui:\/\/expected/);
  });

  it('errors on missing contents / no text body', () => {
    expect('error' in extractAppHtml({ contents: [] })).toBe(true);
    expect('error' in extractAppHtml(null)).toBe(true);
    expect('error' in extractAppHtml({ contents: [{ mimeType: 'image/png', blob: 'AAAA' }] })).toBe(true);
  });

  it('enforces the size cap', () => {
    const big = 'a'.repeat(100);
    const result = extractAppHtml({
      contents: [{ mimeType: 'text/html;profile=mcp-app', text: big }],
    }, 10);
    expect('error' in result && result.error).toMatch(/size cap/);
  });
});

describe('constants', () => {
  it('sandbox excludes allow-same-origin (Phase 1 isolation boundary)', () => {
    expect(MCP_APP_IFRAME_SANDBOX).toBe('allow-scripts');
    expect(MCP_APP_IFRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('exposes the ui:// scheme and a positive size cap', () => {
    expect(UI_RESOURCE_SCHEME).toBe('ui://');
    expect(MAX_UI_RESOURCE_BYTES).toBeGreaterThan(0);
  });
});
