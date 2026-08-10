jest.mock('@modelcontextprotocol/ext-apps/app-bridge', () => {
  const objectSchema = {
    safeParse: (value: unknown) => (
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { success: true, data: value }
        : { success: false }
    ),
  };
  return {
    AppBridge: class {},
    PostMessageTransport: class {},
    RESOURCE_MIME_TYPE: 'text/html;profile=mcp-app',
    buildAllowAttribute: () => '',
    McpUiResourceCspSchema: objectSchema,
    McpUiResourcePermissionsSchema: objectSchema,
  };
});

import {
  allowLoopbackCspGrant,
  buildSandboxUrl,
  buildToolResult,
  canUseDisplayMode,
  clampInlineSize,
  contentToText,
  deliverToolOutcome,
  extractAppResource,
  getSafeOpenLinkUrl,
  getVerifiedPostHandshakeDisplayMode,
  jsonUtf8ByteLength,
  MAX_MCP_APP_CONTEXT_BYTES,
  mcpAppDeliveryIdentity,
  mcpAppSandboxCacheKey,
  normalizeStableAppMessage,
  sanitizeGrantedCsp,
  sanitizeGrantedPermissions,
  validateModelContext,
} from '@/frontend/components/Chat/McpAppFrame';
import { canFullscreenCanvas } from '@/frontend/components/Chat/DevCanvasDock';
import {
  emptyCanvasState,
  openCanvasApp,
  updateCanvasApp,
} from '@/frontend/components/Chat/canvasState';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });

const URI = 'ui://example/app';
const MIME = 'text/html;profile=mcp-app';

describe('MCP App delivery identity', () => {
  it('treats linked-tool changes as a new View delivery', () => {
    expect(mcpAppDeliveryIdentity('tool-a', undefined, undefined, undefined, undefined, undefined))
      .not.toBe(mcpAppDeliveryIdentity('tool-b', undefined, undefined, undefined, undefined, undefined));
    expect(mcpAppDeliveryIdentity('tool-a', 7, undefined, undefined, undefined, undefined))
      .toBe(mcpAppDeliveryIdentity('tool-a', 7, 'ignored when versioned', undefined, undefined, undefined));
  });

  it('encodes sandbox cache identities without delimiter collisions', () => {
    expect(mcpAppSandboxCacheKey('workspace', 'a::b', 'c'))
      .not.toBe(mcpAppSandboxCacheKey('workspace', 'a', 'b::c'));
    expect(mcpAppSandboxCacheKey('workspace-a', 'server', URI))
      .not.toBe(mcpAppSandboxCacheKey('workspace-b', 'server', URI));
  });
});

describe('MCP App resource validation', () => {
  it('selects only the exact requested URI with the stable MIME type', () => {
    const resource = extractAppResource({
      contents: [
        { uri: 'ui://example/other', mimeType: MIME, text: '<p>wrong URI</p>' },
        { uri: URI, mimeType: 'text/html', text: '<p>wrong MIME</p>' },
        {
          uri: URI,
          mimeType: 'text/html; charset=utf-8; profile=mcp-app',
          text: '<p>right</p>',
          _meta: {
            ui: {
              csp: { connectDomains: ['https://api.example.com'] },
              permissions: { clipboardWrite: {} },
            },
          },
        },
      ],
    }, URI);

    expect(resource).toEqual({
      html: '<p>right</p>',
      csp: {
        connectDomains: ['https://api.example.com'],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      permissions: { clipboardWrite: {} },
    });
  });

  it('decodes base64 HTML as UTF-8', () => {
    const html = '<p>¡Hola, 世界!</p>';
    const resource = extractAppResource({
      contents: [{
        uri: URI,
        mimeType: MIME,
        blob: Buffer.from(html, 'utf8').toString('base64'),
      }],
    }, URI);

    expect(resource.html).toBe(html);
  });

  it.each([
    [{ contents: [{ uri: URI, mimeType: 'text/html', text: '<p>plain</p>' }] }],
    [{ contents: [{ uri: 'ui://example/other', mimeType: MIME, text: '<p>other</p>' }] }],
    [{ contents: [{ uri: URI, mimeType: MIME, blob: '%%%not-base64%%%' }] }],
  ])('rejects non-conforming resource content', (readResult) => {
    expect(() => extractAppResource(readResult, URI)).toThrow();
  });
});

describe('loopback CSP grant mirror', () => {
  it('gates the loopback allowance on a plain-HTTP FLUJO origin', () => {
    expect(allowLoopbackCspGrant({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    expect(allowLoopbackCspGrant({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
    expect(allowLoopbackCspGrant({ protocol: 'http:', hostname: '[::1]' })).toBe(true);
    // A `network`-mode install is reached by its LAN name/address while its MCP
    // App servers still bind loopback, so the grant must survive that spelling.
    expect(allowLoopbackCspGrant({ protocol: 'http:', hostname: '192.168.1.20' })).toBe(true);
    expect(allowLoopbackCspGrant({ protocol: 'http:', hostname: 'flujo.local' })).toBe(true);
    // Public/hosted deployments are HTTPS and keep the secure-origin-only grant.
    expect(allowLoopbackCspGrant({ protocol: 'https:', hostname: 'localhost' })).toBe(false);
    expect(allowLoopbackCspGrant({ protocol: 'https:', hostname: 'flujo.example.test' })).toBe(false);
    // jsdom serves the suite from http://localhost, so the browser default applies.
    expect(allowLoopbackCspGrant()).toBe(true);
  });

  it('grants loopback http/ws origins as port wildcards only when allowed', () => {
    const requested = {
      connectDomains: ['http://127.0.0.1:59503', 'ws://127.0.0.1:59503', 'http://insecure.example.com'],
      resourceDomains: ['http://127.0.0.1:59503'],
      frameDomains: ['http://127.0.0.1:59503', 'ws://127.0.0.1:59503'],
      baseUriDomains: ['http://127.0.0.1'],
    };

    // The port is collapsed to `:*` so the grant survives the app server's next
    // ephemeral-port restart, matching the sandbox server's normalizeCspOrigin.
    expect(sanitizeGrantedCsp(requested, true)).toEqual({
      connectDomains: ['http://127.0.0.1:*', 'ws://127.0.0.1:*'],
      resourceDomains: ['http://127.0.0.1:*'],
      // ws: never widens frame-src; portless loopback is rejected.
      frameDomains: ['http://127.0.0.1:*'],
      baseUriDomains: [],
    });

    expect(sanitizeGrantedCsp(requested, false)).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
  });

  it('dedupes several ports on one loopback host into a single granted source', () => {
    expect(sanitizeGrantedCsp({
      frameDomains: ['http://127.0.0.1:4300', 'http://127.0.0.1:4301', 'http://localhost:4302'],
    }, true)).toEqual({
      connectDomains: [],
      resourceDomains: [],
      frameDomains: ['http://127.0.0.1:*', 'http://localhost:*'],
      baseUriDomains: [],
    });
  });
});

describe('MCP App host policy helpers', () => {
  it('accepts the stable single content block for ui/message', () => {
    expect(contentToText({
      role: 'user',
      content: { type: 'text', text: 'selected value' },
    })).toBe('selected value');
    expect(contentToText({
      role: 'user',
      content: [
        { type: 'text', text: 'legacy one' },
        { type: 'text', text: 'legacy two' },
      ],
    })).toBe('legacy one\nlegacy two');
  });

  it('normalizes stable single-block ui/message before SDK schema validation', () => {
    expect(normalizeStableAppMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/message',
      params: {
        role: 'user',
        content: { type: 'text', text: 'hello' },
      },
    } as any)).toMatchObject({
      params: {
        content: [{ type: 'text', text: 'hello' }],
      },
    });
  });

  it('rejects unsupported or undeliverable ui/message content', () => {
    expect(() => contentToText({
      role: 'user',
      content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'x' }],
    })).toThrow(/text-only/);
    expect(() => contentToText({ role: 'user', content: { type: 'text', text: '   ' } }))
      .toThrow(/must not be empty/);
    expect(() => contentToText({
      role: 'assistant',
      content: { type: 'text', text: 'rewrite me' },
    })).toThrow(/role "user"/);
  });

  it('accepts only preserved model-context modalities and enforces 256 KiB', () => {
    expect(validateModelContext({
      content: [{ type: 'text', text: 'context' }],
      structuredContent: { selected: 1 },
    })).toBeNull();
    expect(validateModelContext({
      content: [{ type: 'image', data: 'not preserved' }],
    })).toMatch(/modality/);
    const oversized = { structuredContent: { text: 'x'.repeat(MAX_MCP_APP_CONTEXT_BYTES) } };
    expect(jsonUtf8ByteLength(oversized)).toBeGreaterThan(MAX_MCP_APP_CONTEXT_BYTES);
    expect(validateModelContext(oversized)).toMatch(/exceeds/);
  });

  it.each([
    ['https://example.com/path', 'https://example.com/path'],
    ['http://localhost:3000/path', 'http://localhost:3000/path'],
  ])('allows an HTTP(S) open-link', (input, expected) => {
    expect(getSafeOpenLinkUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/secret',
    '/relative/path',
    'https://user:password@example.com/',
    'not a URL',
  ])('rejects an unsafe open-link: %s', (input) => {
    expect(getSafeOpenLinkUrl(input)).toBeNull();
  });

  it('requires both host and app declarations for a display transition', () => {
    expect(canUseDisplayMode('fullscreen', ['inline', 'fullscreen'], ['inline', 'fullscreen'])).toBe(true);
    expect(canUseDisplayMode('fullscreen', ['inline', 'fullscreen'], ['inline'])).toBe(false);
    expect(canUseDisplayMode('pip', ['inline', 'fullscreen'], ['inline', 'pip'])).toBe(false);
  });

  it('reports only the CSP origins the sandbox will actually grant', () => {
    expect(sanitizeGrantedCsp({
      connectDomains: [
        'https://api.example.com',
        'wss://events.example.com',
        'http://insecure.example.com',
      ],
      resourceDomains: [
        'https://cdn.example.com',
        'wss://not-a-resource.example.com',
        "https://cdn.example.com; script-src *",
      ],
    })).toEqual({
      connectDomains: ['https://api.example.com', 'wss://events.example.com'],
      resourceDomains: ['https://cdn.example.com'],
      frameDomains: [],
      baseUriDomains: [],
    });
  });


  it('reports only permissions effective in the opaque-origin View', () => {
    expect(sanitizeGrantedPermissions({
      camera: {},
      microphone: {},
      geolocation: {},
      clipboardWrite: {},
    })).toEqual({ clipboardWrite: {} });
    expect(sanitizeGrantedPermissions({
      camera: {},
      microphone: {},
      geolocation: {},
    })).toBeUndefined();
  });

  it('starts fresh Views inline and promotes canvas Views only after verification', () => {
    expect(getVerifiedPostHandshakeDisplayMode(
      'pip',
      true,
      ['pip', 'fullscreen'],
      [],
    )).toBeNull();
    expect(getVerifiedPostHandshakeDisplayMode(
      'pip',
      true,
      ['pip', 'fullscreen'],
      ['pip'],
    )).toBe('pip');
    expect(getVerifiedPostHandshakeDisplayMode(
      'fullscreen',
      true,
      ['pip', 'fullscreen'],
      ['pip', 'fullscreen'],
    )).toBe('fullscreen');
    expect(getVerifiedPostHandshakeDisplayMode(
      'pip',
      false,
      ['inline', 'pip'],
      ['inline', 'pip'],
    )).toBe('inline');
  });

  it('allows canvas fullscreen only for one visible pip/fullscreen app', () => {
    const modes: Record<string, Array<'inline' | 'fullscreen' | 'pip'>> = {
      a: ['pip', 'fullscreen'],
      b: ['pip', 'fullscreen'],
    };
    expect(canFullscreenCanvas(['a'], modes)).toBe(true);
    expect(canFullscreenCanvas(['a', 'b'], modes)).toBe(false);
    expect(canFullscreenCanvas([], modes)).toBe(false);
  });

  it('accepts server-derived isolated origins and scoped LAN fallback URLs', () => {
    const originKey = `app${'a'.repeat(60)}`;
    expect(buildSandboxUrl(
      {
        url: `https://${originKey}.apps.example.test/sandbox.html`,
        token: 'secret',
        originKey,
        shared: false,
      },
      { origin: 'https://flujo.example.test', protocol: 'https:' },
    )).toBe(`https://${originKey}.apps.example.test/sandbox.html?token=secret`);
    expect(buildSandboxUrl(
      {
        url: `http://${originKey}.localhost:4201/sandbox.html`,
        port: 4201,
        token: 'secret',
        originKey,
        shared: false,
      },
      { origin: 'http://localhost:3000', protocol: 'http:' },
    )).toBe(`http://${originKey}.localhost:4201/sandbox.html?token=secret`);

    expect(() => buildSandboxUrl(
      { port: 4201, token: 'secret', originKey, shared: false },
      { origin: 'http://localhost:3000', protocol: 'http:' },
    )).toThrow(/isolated app URL/);
    expect(buildSandboxUrl(
      {
        url: `http://192.168.1.20:4201/sandbox.html?originKey=${originKey}`,
        token: 'secret',
        originKey,
        shared: true,
      },
      { origin: 'http://192.168.1.20:4200', protocol: 'http:' },
    )).toBe(
      `http://192.168.1.20:4201/sandbox.html?originKey=${originKey}&token=secret`,
    );
    expect(() => buildSandboxUrl(
      {
        url: 'http://192.168.1.20:4201/sandbox.html?originKey=another-app',
        token: 'secret',
        originKey,
        shared: true,
      },
      { origin: 'http://192.168.1.20:4200', protocol: 'http:' },
    )).toThrow(/verified app origin key/);
    expect(() => buildSandboxUrl(
      {
        url: 'https://unrelated.apps.example.test/sandbox.html',
        token: 'secret',
        originKey,
        shared: false,
      },
      { origin: 'https://flujo.example.test', protocol: 'https:' },
    )).toThrow(/verified app origin key/);
  });

  it('clamps finite inline View size requests', () => {
    expect(clampInlineSize({ width: 900, height: 9000 }, 640)).toEqual({
      width: 640,
      height: 6000,
    });
    expect(clampInlineSize({ width: Infinity, height: -1 }, 640)).toEqual({});
  });
});

describe('persistent MCP App tool delivery state', () => {
  it('wraps non-CallToolResult text instead of dropping it', () => {
    expect(buildToolResult('plain result')).toEqual({
      content: [{ type: 'text', text: 'plain result' }],
    });
    expect(buildToolResult('failed', true)).toEqual({
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    });
  });

  it('sends matching input before each result or cancellation', async () => {
    const order: string[] = [];
    const bridge = {
      sendToolInput: jest.fn(async () => { order.push('input'); }),
      sendToolResult: jest.fn(async () => { order.push('result'); }),
      sendToolCancelled: jest.fn(async () => { order.push('cancelled'); }),
    };

    await deliverToolOutcome(bridge as any, '{"path":"a"}', 'done', undefined);
    expect(order).toEqual(['input', 'result']);
    expect(bridge.sendToolInput).toHaveBeenLastCalledWith({ arguments: { path: 'a' } });

    order.length = 0;
    await deliverToolOutcome(bridge as any, '{"path":"b"}', 'ignored', 'user stopped');
    expect(order).toEqual(['input', 'cancelled']);
    expect(bridge.sendToolCancelled).toHaveBeenLastCalledWith({ reason: 'user stopped' });
  });

  it('tracks identical deliveries by update id and clears cancellation on success', () => {
    let state = openCanvasApp(emptyCanvasState, {
      serverName: 'filesystem',
      uri: URI,
      toolArgs: '{"path":"a"}',
      cancelledReason: 'user cancelled',
      updateId: 'call-1',
    }, 1).state;

    expect(state.entries[`filesystem::${URI}`].latestToolCancelledReason).toBe('user cancelled');
    expect(state.entries[`filesystem::${URI}`].latestResultContent).toBeUndefined();

    state = updateCanvasApp(state, {
      serverName: 'filesystem',
      uri: URI,
      toolArgs: '{"path":"a"}',
      resultContent: 'same bytes',
      isError: false,
      updateId: 'call-2',
    }, 2);

    const entry = state.entries[`filesystem::${URI}`];
    expect(entry.latestToolUpdateId).toBe('call-2');
    expect(entry.latestToolCancelledReason).toBeUndefined();
    expect(entry.latestResultContent).toBe('same bytes');
    expect(entry.latestToolIsError).toBe(false);
  });
});
