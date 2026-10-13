/**
 * Tests for ModelHandler.extractProviderErrorDetails — the single helper both
 * provider-error paths share (HTTP 200 with an error body, and a thrown
 * OpenAI.APIError). It must surface OpenRouter's nested upstream reason
 * (metadata.provider_name / raw) and retry_after_seconds consistently,
 * including when metadata.raw is a plain (non-JSON) string.
 */
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { normalizeChatError } from '@/backend/execution/flow/normalizeError';

// The method is private; call it through a typed-loose handle.
const extract = (body: unknown, base?: string) =>
  (ModelHandler as any).extractProviderErrorDetails(body, base) as {
    message: string;
    code?: unknown;
    retryAfter?: string;
    providerError?: unknown;
  };

describe('ModelHandler.extractProviderErrorDetails', () => {
  it('surfaces a plain-string upstream reason + provider name (200-error-body path)', () => {
    const body = {
      message: 'Provider returned error',
      code: 429,
      metadata: {
        provider_name: 'Venice',
        raw: 'meta-llama/llama-3.3-70b-instruct:free is temporarily rate-limited upstream. Please retry shortly.',
        retry_after_seconds: 26,
      },
    };

    const r = extract(body);

    expect(r.message).toMatch(/Provider returned error/);
    expect(r.message).toMatch(/Venice/);
    expect(r.message).toMatch(/rate-limited upstream/);
    expect(r.code).toBe(429);
    expect(r.retryAfter).toBe('26');
    expect(r.providerError).toBe(body);
  });

  it('builds on the SDK base message and appends the body message (APIError path)', () => {
    const body = {
      message: 'Provider returned error',
      code: 429,
      metadata: { provider_name: 'Venice', raw: 'rate limited' },
    };

    const r = extract(body, '429 Provider returned error');

    // base + body message, then upstream detail.
    expect(r.message).toBe('429 Provider returned error - Provider returned error (upstream: Venice: rate limited)');
  });

  it('parses a JSON-string metadata.raw and prefers its nested message', () => {
    const body = {
      message: 'err',
      metadata: { raw: JSON.stringify({ error: { message: 'deep upstream message' } }) },
    };

    const r = extract(body);

    expect(r.message).toMatch(/deep upstream message/);
  });

  it('falls back gracefully when there is no metadata', () => {
    const r = extract({ message: 'plain error', code: 'bad_request' });
    expect(r.message).toBe('plain error');
    expect(r.code).toBe('bad_request');
    expect(r.retryAfter).toBeUndefined();
  });
});

describe('provider raw reasons at the normalization boundary', () => {
  const key = 'sk-providerSECRET12345678';
  const token = 'provider-token-12345678';
  const raw = 'Provider refused credential ' + key + ' and bEaReR ' + token + '.';
  const safe = 'Provider refused credential [REDACTED] and Bearer [REDACTED]';
  const metadataBody = (reason: unknown) => ({
    message: 'Provider returned error', metadata: { provider_name: 'Fixture provider', raw: reason },
  });

  it.each<[string, unknown, string | undefined]>([
    ['body.message', { message: raw }, undefined],
    ['SDK base message', { message: 'Provider returned error' }, raw],
    ['plain metadata.raw', metadataBody(raw), '429 Provider returned error'],
    ['JSON metadata.raw', metadataBody(JSON.stringify({ error: { message: raw } })), '429 Provider returned error'],
    ['nested object metadata.raw', metadataBody({ error: { message: raw } }), undefined],
    ['flat object metadata.raw', metadataBody({ message: raw }), undefined],
  ])('masks the actual extracted %s before serialization', (_label, body, base) => {
    const extracted = extract(body, base);
    expect(extracted.message).toContain(raw);
    expect(extracted.providerError).toBe(body);
    const error = Object.assign(new Error(extracted.message), {
      details: {
        status: 429, code: 'rate_limit_exceeded', type: 'rate_limit_error',
        retryAfter: '7', providerError: extracted.providerError,
      },
    });
    const norm = normalizeChatError(error);
    expect(norm.message).toContain(safe);
    expect(norm).toMatchObject({
      httpStatus: 429, code: 'rate_limit_exceeded', providerType: 'rate_limit_error',
      retryAfter: '7', errorClass: 'rate_limit',
    });
    const serialized = JSON.stringify(norm);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain(token);
    expect(error.message).toBe(extracted.message);
  });
});
