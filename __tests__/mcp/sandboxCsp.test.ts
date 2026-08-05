/**
 * MCP Apps (#97) Phase 2 — the sandbox origin's HTTP CSP header builder.
 *
 * The sandbox document runs on a throwaway foreign origin, so `'self'` there is
 * NOT FLUJO. The header must default-deny network egress and reject any
 * server-declared CSP token that could break out of its directive.
 */
import {
  buildSandboxCsp,
  buildSandboxProxyCsp,
  buildSandboxProxyHtml,
  deriveSandboxPublicUrl,
  getConfiguredSandboxHostOrigins,
  getSandboxPublicUrl,
  SANDBOX_HOST_ORIGINS_ENV,
  SANDBOX_PUBLIC_URL_ENV,
} from '@/backend/mcpApps/sandboxServer';

describe('buildSandboxCsp', () => {
  it('defaults to no network egress and blocks framing/base/object', () => {
    const csp = buildSandboxCsp(undefined);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("media-src 'self' data:");
    expect(csp).toContain("font-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('frame-ancestors');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('blob:');
  });

  it('widens only the mapped directive from declared domains', () => {
    const csp = buildSandboxCsp({
      connectDomains: ['https://api.example.com', 'wss://events.example.com'],
      resourceDomains: ['https://cdn.example.com', 'https://*.assets.example.com:8443'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com'],
    });
    expect(csp).toMatch(/connect-src https:\/\/api\.example\.com wss:\/\/events\.example\.com/);
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.example\.com/);
    expect(csp).toMatch(/style-src[^;]*https:\/\/\*\.assets\.example\.com:8443/);
    expect(csp).toMatch(/img-src[^;]*https:\/\/cdn\.example\.com/);
    expect(csp).toMatch(/font-src https:\/\/cdn\.example\.com/);
    expect(csp).toMatch(/media-src[^;]*https:\/\/cdn\.example\.com/);
    expect(csp).toMatch(/frame-src https:\/\/embed\.example\.com/);
    expect(csp).toMatch(/base-uri https:\/\/base\.example\.com/);
    // A resource domain must not leak into connect-src.
    expect(csp).not.toMatch(/connect-src[^;]*cdn\.example\.com/);
    expect(csp).not.toMatch(/worker-src[^;]*cdn\.example\.com/);
    expect(csp).not.toMatch(/frame-src[^;]*cdn\.example\.com/);
  });

  it('drops injection payloads and non-origin CSP expressions rather than emitting them', () => {
    const csp = buildSandboxCsp({
      connectDomains: [
        "https://ok.example.com",
        "https://evil.com; script-src 'unsafe-eval'", // directive break-out
        "https://a.com b.com",                          // space-separated smuggle
        'https://a.com,b.com',                          // second-policy separator
        "'unsafe-inline'",                              // quoted keyword
        'https://x.com\n; default-src *',               // newline break-out
        'https://user:password@example.com',             // credentials
        'https://example.com/path',                      // metadata requires an origin
        'https://example.com?next=https://evil.test',
        'https://example.com:99999',
        'data:',
        'blob:',
        '*',
        'http://insecure.example.com',
      ],
    });
    expect(csp).toContain('https://ok.example.com');
    expect(csp).not.toContain('evil.com'); // directive break-out payload dropped whole
    expect(csp).not.toContain('b.com');
    expect(csp).not.toContain('default-src *');
    // The injected tokens must not have widened connect-src with a keyword/host.
    expect(csp).not.toMatch(/connect-src[^;]*unsafe/);
    expect(csp).not.toMatch(/connect-src[^;]*x\.com/);
    expect(csp).not.toContain('user:password');
    expect(csp).not.toContain('99999');
    expect(csp).not.toContain('insecure.example.com');
    expect(csp).not.toMatch(/connect-src[^;]*data:/);
    expect(csp).not.toContain('blob:');
  });

  it('is embedded as the first bytes of the written View document after sanitization', () => {
    const html = buildSandboxProxyHtml([], false, {
      connectDomains: [
        'https://api.example.com',
        "https://evil.example; script-src 'unsafe-eval'",
      ],
      frameDomains: ['https://embed.example.com'],
    });
    expect(html).toContain(
      'var INNER_CSP_META = "<meta http-equiv=\\"Content-Security-Policy\\"'
    );
    expect(html).toContain('connect-src https://api.example.com');
    expect(html).toContain('frame-src https://embed.example.com');
    expect(html).not.toContain('evil.example');
    // The policy precedes every untrusted byte on both the document.write path
    // and the srcdoc fallback.
    expect(html).toContain('doc.write(INNER_CSP_META + html)');
    expect(html).toContain('frame.srcdoc = INNER_CSP_META + html');
  });
});

describe('loopback CSP origins (localhost exposure mode)', () => {
  const originalExposure = process.env.FLUJO_EXPOSURE_MODE;

  afterEach(() => {
    if (originalExposure === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = originalExposure;
  });

  const loopbackCsp = {
    connectDomains: ['http://127.0.0.1:59503', 'ws://127.0.0.1:59503'],
    resourceDomains: ['http://127.0.0.1:59503'],
    frameDomains: ['http://127.0.0.1:59503'],
    baseUriDomains: ['http://127.0.0.1:59503'],
  };

  it('admits explicit-port loopback http/ws origins into both policies', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    for (const csp of [buildSandboxCsp(loopbackCsp), buildSandboxProxyCsp('http://127.0.0.1:4200', loopbackCsp)]) {
      expect(csp).toMatch(/connect-src http:\/\/127\.0\.0\.1:59503 ws:\/\/127\.0\.0\.1:59503/);
      expect(csp).toMatch(/frame-src[^;]*http:\/\/127\.0\.0\.1:59503/);
      expect(csp).toMatch(/img-src[^;]*http:\/\/127\.0\.0\.1:59503/);
      expect(csp).toMatch(/base-uri[^;]*http:\/\/127\.0\.0\.1:59503/);
    }
  });

  it('accepts localhost and [::1] loopback spellings', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const csp = buildSandboxCsp({
      connectDomains: ['ws://localhost:4300', 'http://[::1]:4300'],
    });
    expect(csp).toContain('ws://localhost:4300');
    expect(csp).toContain('http://[::1]:4300');
  });

  it('keeps ws: out of non-connect directives and requires an explicit port', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const csp = buildSandboxCsp({
      frameDomains: ['ws://127.0.0.1:59503', 'http://127.0.0.1'],
      connectDomains: ['http://localhost'],
    });
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  it('still rejects non-loopback http/ws hosts in localhost mode', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const csp = buildSandboxCsp({
      connectDomains: ['http://insecure.example.com', 'ws://evil.test:4300', 'http://127.0.0.1.evil.test:4300'],
    });
    expect(csp).toContain("connect-src 'none'");
  });

  it('drops loopback http/ws origins outside the localhost exposure mode', () => {
    for (const mode of ['network', 'public']) {
      process.env.FLUJO_EXPOSURE_MODE = mode;
      const csp = buildSandboxCsp(loopbackCsp);
      expect(csp).toContain("connect-src 'none'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).not.toContain('127.0.0.1:59503');
      const proxyCsp = buildSandboxProxyCsp('https://flujo.example.test', loopbackCsp);
      expect(proxyCsp).not.toContain('127.0.0.1:59503');
    }
  });
});

describe('buildSandboxProxyCsp', () => {
  it('permits inline View media, the mandatory srcdoc child, and the exact host ancestor', () => {
    const csp = buildSandboxProxyCsp('http://127.0.0.1:4200');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("media-src 'self' data:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain('frame-ancestors http://127.0.0.1:4200');
    expect(csp).not.toContain('blob:');
  });

  it('uses sanitized app declarations as the inherited View policy upper bound', () => {
    const requestedCsp = {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: ['https://embed.example.com'],
      baseUriDomains: ['https://base.example.com'],
    };
    const innerCsp = buildSandboxCsp(requestedCsp);
    const proxyCsp = buildSandboxProxyCsp('https://flujo.example.test', requestedCsp);

    expect(innerCsp).toContain('api.example.com');
    expect(innerCsp).toContain('cdn.example.com');
    expect(innerCsp).toContain('embed.example.com');
    expect(proxyCsp).toMatch(/connect-src https:\/\/api\.example\.com/);
    expect(proxyCsp).toMatch(/img-src[^;]*https:\/\/cdn\.example\.com/);
    expect(proxyCsp).toMatch(/frame-src 'self' https:\/\/embed\.example\.com/);
    expect(proxyCsp).toMatch(/base-uri 'self' https:\/\/base\.example\.com/);
  });

  it('drops unsafe app declarations from the inherited View policy upper bound', () => {
    const proxyCsp = buildSandboxProxyCsp('https://flujo.example.test', {
      connectDomains: ["https://evil.example; img-src *", 'data:'],
      resourceDomains: ['http://insecure.example.com', 'blob:'],
      frameDomains: ['javascript:alert(1)'],
    });

    expect(proxyCsp).not.toContain('evil.example');
    expect(proxyCsp).not.toContain('insecure.example.com');
    expect(proxyCsp).not.toContain('javascript:');
    expect(proxyCsp).not.toContain('blob:');
    expect(proxyCsp).toContain("connect-src 'none'");
    expect(proxyCsp).toContain("frame-src 'self'");
  });

  it('fails closed for a missing or non-HTTP frame ancestor', () => {
    expect(buildSandboxProxyCsp()).toContain("frame-ancestors 'none'");
    expect(buildSandboxProxyCsp('javascript:alert(1)')).toContain(
      "frame-ancestors 'none'"
    );
  });
});

describe('hosted sandbox endpoint configuration', () => {
  const originalPublicUrl = process.env[SANDBOX_PUBLIC_URL_ENV];
  const originalHostOrigins = process.env[SANDBOX_HOST_ORIGINS_ENV];
  const originalExposure = process.env.FLUJO_EXPOSURE_MODE;
  const originalExposureSource = process.env.FLUJO_EXPOSURE_MODE_SOURCE;

  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env[SANDBOX_PUBLIC_URL_ENV];
    else process.env[SANDBOX_PUBLIC_URL_ENV] = originalPublicUrl;
    if (originalHostOrigins === undefined) delete process.env[SANDBOX_HOST_ORIGINS_ENV];
    else process.env[SANDBOX_HOST_ORIGINS_ENV] = originalHostOrigins;
    if (originalExposure === undefined) delete process.env.FLUJO_EXPOSURE_MODE;
    else process.env.FLUJO_EXPOSURE_MODE = originalExposure;
    if (originalExposureSource === undefined) delete process.env.FLUJO_EXPOSURE_MODE_SOURCE;
    else process.env.FLUJO_EXPOSURE_MODE_SOURCE = originalExposureSource;
  });

  it('normalizes a separately hosted public URL and rejects credentialed URLs', () => {
    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://apps.example.test';
    expect(getSandboxPublicUrl()).toBe('https://apps.example.test/sandbox.html');

    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://user:secret@apps.example.test/';
    expect(getSandboxPublicUrl()).toBeUndefined();
  });

  it('derives the HTTPS sandbox origin from the one Public setting', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    expect(deriveSandboxPublicUrl('https://flujo.example.test', 4201)).toBe(
      'https://flujo.example.test:4201/sandbox.html',
    );

    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    expect(deriveSandboxPublicUrl('https://flujo.example.test', 4201)).toBeUndefined();
  });

  it('uses only exact valid host origins and embeds the allowlist in the proxy', () => {
    process.env[SANDBOX_HOST_ORIGINS_ENV] =
      'https://flujo.example.test, https://flujo.example.test, javascript:bad';

    expect(getConfiguredSandboxHostOrigins()).toEqual(['https://flujo.example.test']);
    const html = buildSandboxProxyHtml();
    expect(html).toContain('var HOST_ALLOWLIST_CONFIGURED = true');
    expect(html).toContain('["https://flujo.example.test"]');
    expect(html).not.toContain('javascript:bad');
  });

  it('ignores leftover public sandbox variables when Settings narrows access', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    process.env.FLUJO_EXPOSURE_MODE_SOURCE = 'settings';
    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://old-apps.example.test';
    process.env[SANDBOX_HOST_ORIGINS_ENV] = 'https://old-flujo.example.test';

    expect(getSandboxPublicUrl()).toBeUndefined();
    expect(getConfiguredSandboxHostOrigins()).toEqual([]);
  });
});
