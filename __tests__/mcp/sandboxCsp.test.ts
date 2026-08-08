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
  hasValidSandboxAppUrlTemplate,
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

describe('loopback CSP origins (self-hosted exposure modes)', () => {
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

  it.each(['localhost', 'network'])(
    'admits loopback http/ws origins into both policies in %s mode',
    (mode) => {
      process.env.FLUJO_EXPOSURE_MODE = mode;
      for (const csp of [buildSandboxCsp(loopbackCsp), buildSandboxProxyCsp('http://127.0.0.1:4200', loopbackCsp)]) {
        expect(csp).toMatch(/connect-src http:\/\/127\.0\.0\.1:\* ws:\/\/127\.0\.0\.1:\*/);
        expect(csp).toMatch(/frame-src[^;]*http:\/\/127\.0\.0\.1:\*/);
        expect(csp).toMatch(/img-src[^;]*http:\/\/127\.0\.0\.1:\*/);
        expect(csp).toMatch(/base-uri[^;]*http:\/\/127\.0\.0\.1:\*/);
      }
    },
  );

  // Regression: an app whose gateway lives on loopback (a local IDE/workbench)
  // must still be frameable after the operator switches on LAN access.
  it('keeps a loopback gateway frameable in network mode', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'network';
    const gateway = 'http://127.0.0.1:65459';
    const appCsp = { frameDomains: [gateway], connectDomains: [gateway, 'ws://127.0.0.1:65459'] };
    expect(buildSandboxCsp(appCsp)).toContain('frame-src http://127.0.0.1:*');
    expect(buildSandboxProxyCsp('http://192.168.1.20:4200', appCsp))
      .toContain("frame-src 'self' http://127.0.0.1:*");
  });

  // Regression: local App servers bind an EPHEMERAL port (`listen(0)`), so the
  // port declared in `_meta.ui.csp` is stale after the server restarts. The host
  // commits the CSP once as a response header and never re-issues it, so a pinned
  // port made the app load once and then fail with the granted and framed ports
  // exactly one restart apart. The wildcard keeps the committed policy valid.
  it('survives an ephemeral-port restart of the app server', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'network';
    const committed = buildSandboxCsp({ frameDomains: ['http://127.0.0.1:56186'] });
    expect(committed).toContain('frame-src http://127.0.0.1:*');
    // The port the app frames after its next restart is NOT the granted one.
    expect(committed).not.toContain('56186');
    for (const restartedPort of [56315, 56379, 53184]) {
      expect(committed).toContain('frame-src http://127.0.0.1:*');
      expect(`http://127.0.0.1:${restartedPort}`).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }
  });

  it('collapses several ports on one loopback host into a single source', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const csp = buildSandboxCsp({
      frameDomains: ['http://127.0.0.1:4300', 'http://127.0.0.1:4301', 'http://127.0.0.1:4302'],
    });
    expect(csp).toContain('frame-src http://127.0.0.1:*;');
  });

  it('accepts localhost and [::1] loopback spellings', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    const csp = buildSandboxCsp({
      connectDomains: ['ws://localhost:4300', 'http://[::1]:4300'],
    });
    expect(csp).toContain('ws://localhost:*');
    expect(csp).toContain('http://[::1]:*');
  });

  it('accepts an already-wildcarded loopback port but never a portless host', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    expect(buildSandboxCsp({ frameDomains: ['http://127.0.0.1:*'] }))
      .toContain('frame-src http://127.0.0.1:*');
    expect(buildSandboxCsp({ frameDomains: ['http://127.0.0.1'] }))
      .toContain("frame-src 'none'");
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

  it('drops loopback http/ws origins in the public exposure mode', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    const csp = buildSandboxCsp(loopbackCsp);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    // Neither the declared port nor the widened wildcard may leak.
    expect(csp).not.toContain('127.0.0.1');
    const proxyCsp = buildSandboxProxyCsp('https://flujo.example.test', loopbackCsp);
    expect(proxyCsp).not.toContain('127.0.0.1');
    // A port wildcard is not a way around the public-mode denial either.
    expect(buildSandboxCsp({ frameDomains: ['http://127.0.0.1:*'] }))
      .toContain("frame-src 'none'");
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

  it('names every trusted ancestor so a nested embedding chain is allowed', () => {
    // A hosted demo frames the editor inside its own landing page, so the
    // sandbox has two ancestors and the browser matches frame-ancestors against
    // BOTH. Naming only the immediate parent blocks the top-level page.
    expect(
      buildSandboxProxyCsp(['https://now.try.example.test', 'https://try.example.test'])
    ).toContain('frame-ancestors https://now.try.example.test https://try.example.test');
  });

  it('dedupes ancestors, drops invalid ones, and fails closed when none remain', () => {
    // Collapses to a single source (frame-ancestors is the final directive).
    expect(
      buildSandboxProxyCsp(['https://a.example.test', 'https://a.example.test/path'])
    ).toMatch(/frame-ancestors https:\/\/a\.example\.test$/);
    expect(buildSandboxProxyCsp(['javascript:alert(1)', 'not a url'])).toContain(
      "frame-ancestors 'none'"
    );
    expect(buildSandboxProxyCsp([])).toContain("frame-ancestors 'none'");
  });
});

describe('hosted sandbox endpoint configuration', () => {
  const originKey = `app${'c'.repeat(60)}`;
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
    delete process.env.FLUJO_EXPOSURE_MODE_SOURCE;
    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://apps.example.test';
    expect(getSandboxPublicUrl()).toBe('https://apps.example.test/sandbox.html');
    expect(hasValidSandboxAppUrlTemplate()).toBe(false);

    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://user:secret@apps.example.test/';
    expect(getSandboxPublicUrl()).toBeUndefined();
  });

  it('derives only keyed localhost or wildcard-hosted origins', () => {
    delete process.env.FLUJO_EXPOSURE_MODE_SOURCE;
    process.env.FLUJO_EXPOSURE_MODE = 'public';
    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://apps.example.test';
    expect(deriveSandboxPublicUrl('https://flujo.example.test', 4201, originKey))
      .toBeUndefined();

    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://{app}.sandbox.example.test';
    expect(hasValidSandboxAppUrlTemplate()).toBe(true);
    expect(deriveSandboxPublicUrl('https://flujo.example.test', 4201, originKey)).toBe(
      `https://${originKey}.sandbox.example.test/sandbox.html`,
    );

    process.env.FLUJO_EXPOSURE_MODE = 'localhost';
    expect(deriveSandboxPublicUrl('https://flujo.example.test', 4201, originKey)).toBe(
      `http://${originKey}.localhost:4201/sandbox.html`,
    );
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

  it('honors a wildcard template when Settings enables Local Network access', () => {
    process.env.FLUJO_EXPOSURE_MODE = 'network';
    process.env.FLUJO_EXPOSURE_MODE_SOURCE = 'settings';
    process.env[SANDBOX_PUBLIC_URL_ENV] = 'https://{app}.lan-sandbox.example.test';

    expect(hasValidSandboxAppUrlTemplate()).toBe(true);
    expect(deriveSandboxPublicUrl('http://192.168.1.20:4200', 4201, originKey)).toBe(
      `https://${originKey}.lan-sandbox.example.test/sandbox.html`,
    );
  });
});
