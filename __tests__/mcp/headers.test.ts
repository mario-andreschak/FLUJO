import {
  isSecretHeaderKey,
  isGlobalBinding,
  isMaskedHeaderValue,
  normalizeHeaderValue,
  flattenHeaders,
  maskServerHeaders,
} from '@/utils/mcp/headers';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import { MCPHeaderValue } from '@/shared/types/mcp/mcp';

describe('isSecretHeaderKey', () => {
  it('treats an "authorization" header as secret (case-insensitive)', () => {
    expect(isSecretHeaderKey('authorization')).toBe(true);
    expect(isSecretHeaderKey('Authorization')).toBe(true);
    expect(isSecretHeaderKey('  AUTHORIZATION ')).toBe(true);
  });

  it('reuses the env-var keyword logic (key / secret / token / password)', () => {
    expect(isSecretHeaderKey('X-Api-Key')).toBe(true);
    expect(isSecretHeaderKey('X-Auth-Token')).toBe(true);
    expect(isSecretHeaderKey('My-Secret')).toBe(true);
    expect(isSecretHeaderKey('X-Password')).toBe(true);
  });

  it('treats ordinary headers as non-secret', () => {
    expect(isSecretHeaderKey('X-SAP-Client')).toBe(false);
    expect(isSecretHeaderKey('Content-Type')).toBe(false);
    expect(isSecretHeaderKey('X-SAP-System-Id')).toBe(false);
  });
});

describe('isGlobalBinding / isMaskedHeaderValue', () => {
  it('detects ${global:VAR} bindings', () => {
    expect(isGlobalBinding('${global:MY_TOKEN}')).toBe(true);
    expect(isGlobalBinding('Bearer abc')).toBe(false);
  });

  it('detects masked placeholders', () => {
    expect(isMaskedHeaderValue(MASKED_API_KEY)).toBe(true);
    expect(isMaskedHeaderValue(MASKED_STRING)).toBe(true);
    expect(isMaskedHeaderValue('real-value')).toBe(false);
  });
});

describe('normalizeHeaderValue', () => {
  it('reads value + isSecret from the object form', () => {
    expect(normalizeHeaderValue({ value: 'v', metadata: { isSecret: true } }, 'X-Foo'))
      .toEqual({ value: 'v', isSecret: true });
  });

  it('infers isSecret from the key for the legacy plain-string form', () => {
    expect(normalizeHeaderValue('Bearer x', 'Authorization')).toEqual({ value: 'Bearer x', isSecret: true });
    expect(normalizeHeaderValue('123', 'X-SAP-Client')).toEqual({ value: '123', isSecret: false });
  });
});

describe('flattenHeaders', () => {
  it('flattens both forms to a plain string map', () => {
    const headers: Record<string, MCPHeaderValue> = {
      'Authorization': { value: 'Bearer x', metadata: { isSecret: true } },
      'X-SAP-Client': '100',
    };
    expect(flattenHeaders(headers)).toEqual({ 'Authorization': 'Bearer x', 'X-SAP-Client': '100' });
  });

  it('returns an empty object for undefined', () => {
    expect(flattenHeaders(undefined)).toEqual({});
  });
});

describe('maskServerHeaders', () => {
  it('masks secret non-bound values with MASKED_API_KEY', () => {
    const out = maskServerHeaders({
      'Authorization': { value: 'encrypted:abc', metadata: { isSecret: true } },
    });
    expect(out).toEqual({ 'Authorization': { value: MASKED_API_KEY, metadata: { isSecret: true } } });
  });

  it('leaves ${global:} bindings intact so the editor can show "bound"', () => {
    const out = maskServerHeaders({
      'Authorization': { value: '${global:TOKEN}', metadata: { isSecret: true } },
    });
    expect(out).toEqual({ 'Authorization': { value: '${global:TOKEN}', metadata: { isSecret: true } } });
  });

  it('passes non-secret values through unchanged', () => {
    const out = maskServerHeaders({
      'X-SAP-Client': { value: '100', metadata: { isSecret: false } },
    });
    expect(out).toEqual({ 'X-SAP-Client': { value: '100', metadata: { isSecret: false } } });
  });

  it('masks a legacy plain-string Authorization header (secret inferred from the key)', () => {
    const out = maskServerHeaders({ 'Authorization': 'Bearer secret' } as Record<string, MCPHeaderValue>);
    expect(out).toEqual({ 'Authorization': { value: MASKED_API_KEY, metadata: { isSecret: true } } });
  });

  it('is a no-op for undefined headers', () => {
    expect(maskServerHeaders(undefined)).toBeUndefined();
  });
});
