/**
 * Unit tests for the allowlist-based bug-report context builder (issue #127).
 *
 * The security-critical property: even if the input object carries secret-shaped extra
 * fields, the built context contains ONLY the allowlisted keys — secrets are dropped by
 * construction.
 */

import {
  buildBugReportContext,
  detectOs,
  detectBrowser,
  sanitizePageUrl,
} from '@/frontend/utils/bugReportContext';
import { SAFE_BUG_CONTEXT_KEYS } from '@/shared/types/bugReport';

describe('detectOs / detectBrowser', () => {
  it('classifies common user agents', () => {
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
    expect(detectOs('')).toBe('unknown');
  });

  it('classifies common browsers', () => {
    expect(detectBrowser('Mozilla/5.0 ... Chrome/120.0 Safari/537.36')).toBe('Chrome');
    expect(detectBrowser('Mozilla/5.0 ... Chrome/120 Safari/537.36 Edg/120.0')).toBe('Edge');
    expect(detectBrowser('Mozilla/5.0 ... Firefox/121.0')).toBe('Firefox');
    expect(detectBrowser('Mozilla/5.0 (Macintosh) ... Version/17.0 Safari/605.1.15')).toBe('Safari');
  });
});

describe('sanitizePageUrl', () => {
  it('keeps a plain relative path', () => {
    expect(sanitizePageUrl('/models')).toBe('/models');
  });

  it('drops the query string but keeps the hash', () => {
    expect(sanitizePageUrl('/chat?access_token=sk-SECRET#msg-1')).toBe('/chat#msg-1');
  });

  it('strips the origin/host from an absolute URL (no tunnel domain leak)', () => {
    expect(sanitizePageUrl('https://abc123.trycloudflare.com/settings?x=1')).toBe('/settings');
  });

  it('never leaks token-shaped query values', () => {
    const out = sanitizePageUrl('/oauth/callback?code=SECRET-CODE&state=SECRET-STATE');
    expect(out).toBe('/oauth/callback');
    expect(out).not.toContain('SECRET');
  });

  it('defaults blank / missing input to unknown', () => {
    expect(sanitizePageUrl('')).toBe('unknown');
    expect(sanitizePageUrl(undefined)).toBe('unknown');
    expect(sanitizePageUrl(null)).toBe('unknown');
  });
});

describe('buildBugReportContext', () => {
  const fixedNow = new Date('2026-07-17T18:00:00.000Z');

  it('emits the allowlisted fields from safe inputs', () => {
    const ctx = buildBugReportContext({
      appVersion: '3.21.0',
      installMode: 'git',
      mcpServerNames: ['github', 'filesystem'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36',
      pageUrl: '/chat#thread',
      now: fixedNow,
    });
    expect(ctx).toEqual({
      appVersion: '3.21.0',
      installMode: 'git',
      os: 'Windows',
      browser: 'Chrome',
      mcpServerNames: ['github', 'filesystem'],
      pageUrl: '/chat#thread',
      timestamp: '2026-07-17T18:00:00.000Z',
    });
  });

  it('defaults missing inputs to unknown / empty', () => {
    const ctx = buildBugReportContext({ now: fixedNow });
    expect(ctx.appVersion).toBe('unknown');
    expect(ctx.installMode).toBe('unknown');
    expect(ctx.mcpServerNames).toEqual([]);
    expect(ctx.pageUrl).toBe('unknown');
  });

  it('NEVER leaks secret-shaped extra fields (allowlist proof)', () => {
    const malicious = {
      appVersion: '3.21.0',
      installMode: 'git',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121.0',
      mcpServerNames: ['srv'],
      now: fixedNow,
      // Secrets that must NOT survive into the context:
      apiKey: 'sk-SECRET-123',
      OPENAI_API_KEY: 'sk-SECRET-456',
      env: { SECRET_TOKEN: 'shh' },
      password: 'hunter2',
      authorization: 'Bearer SECRET',
    } as any;

    const ctx = buildBugReportContext(malicious);

    // Only the allowlisted keys are present.
    expect(Object.keys(ctx).sort()).toEqual([...SAFE_BUG_CONTEXT_KEYS].sort());

    const serialized = JSON.stringify(ctx);
    for (const secret of ['sk-SECRET-123', 'sk-SECRET-456', 'shh', 'hunter2', 'Bearer SECRET']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('captures a relative page url and drops the query string / origin', () => {
    // Query string is dropped (may carry tokens); pathname + hash are kept.
    expect(buildBugReportContext({ pageUrl: '/chat?token=SECRET#a', now: fixedNow }).pageUrl).toBe(
      '/chat#a'
    );
    // An absolute URL that slipped through is reduced to its relative part (no origin/host).
    expect(
      buildBugReportContext({ pageUrl: 'https://my-tunnel.example.com/flows?k=v', now: fixedNow })
        .pageUrl
    ).toBe('/flows');
  });

  it('filters non-string mcp server names', () => {
    const ctx = buildBugReportContext({
      mcpServerNames: ['ok', '', 42 as any, null as any, 'fine'],
      now: fixedNow,
    });
    expect(ctx.mcpServerNames).toEqual(['ok', 'fine']);
  });
});
