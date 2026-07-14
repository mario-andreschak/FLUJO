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
} from '@/shared/utils/mcpApps';

// MCP Apps (SEP-1865, #97) — pure helpers for Phase 1 read-only rendering.

describe('isUiResourceUri', () => {
  it('accepts ui:// URIs (case-insensitive, tolerant of leading space)', () => {
    expect(isUiResourceUri('ui://weather-dashboard')).toBe(true);
    expect(isUiResourceUri('UI://Thing')).toBe(true);
    expect(isUiResourceUri('  ui://x')).toBe(true);
  });

  it('rejects non-ui schemes and non-strings', () => {
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
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // inline is allowed so a self-contained srcdoc can run.
    expect(csp).toContain("script-src 'unsafe-inline'");
  });

  it('widens only the mapped directive per declared domain list', () => {
    const csp = buildAppCsp({
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://frame.example.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(csp).toContain('connect-src https://api.example.com');
    expect(csp).toContain('script-src \'unsafe-inline\' https://cdn.example.com');
    expect(csp).toContain('frame-src https://frame.example.com');
    expect(csp).toContain('base-uri https://base.example.com');
    // connect-src must NOT have been widened by resourceDomains.
    expect(csp).not.toContain('connect-src https://cdn.example.com');
  });

  it('trims and drops empty entries', () => {
    const csp = buildAppCsp({ connectDomains: ['  https://a.com  ', '', '   '] });
    expect(csp).toContain('connect-src https://a.com');
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

  it('falls back to the first text entry when no mcp-app entry is present', () => {
    const result = extractAppHtml({ contents: [{ text: '<p>plain</p>' }] });
    expect('html' in result && result.html).toBe('<p>plain</p>');
  });

  it('surfaces the resource _meta.ui block', () => {
    const result = extractAppHtml({
      contents: [
        {
          mimeType: 'text/html;profile=mcp-app',
          text: '<h1>A</h1>',
          _meta: { ui: { connectDomains: ['https://api.example.com'] } },
        } as never,
      ],
    });
    expect('html' in result && result.meta?.connectDomains).toEqual(['https://api.example.com']);
  });

  it('errors on missing contents / no text body', () => {
    expect('error' in extractAppHtml({ contents: [] })).toBe(true);
    expect('error' in extractAppHtml(null)).toBe(true);
    expect('error' in extractAppHtml({ contents: [{ mimeType: 'image/png', blob: 'AAAA' }] })).toBe(true);
  });

  it('enforces the size cap', () => {
    const big = 'a'.repeat(100);
    const result = extractAppHtml({ contents: [{ text: big }] }, 10);
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
