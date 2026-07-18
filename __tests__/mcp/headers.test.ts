import {
  isSecretHeaderKey,
  isGlobalBinding,
  isMaskedHeaderValue,
  normalizeHeaderValue,
  flattenHeaders,
  maskServerHeaders,
  hydrateMaskedHeaders,
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

describe('hydrateMaskedHeaders (#137)', () => {
  it('replaces a masked SECRET value with the stored (encrypted) counterpart', () => {
    const incoming: Record<string, MCPHeaderValue> = {
      'Authorization': { value: MASKED_API_KEY, metadata: { isSecret: true } },
    };
    const stored: Record<string, MCPHeaderValue> = {
      'Authorization': { value: 'encrypted:abc', metadata: { isSecret: true } },
    };
    expect(hydrateMaskedHeaders(incoming, stored)).toEqual({
      'Authorization': { value: 'encrypted:abc', metadata: { isSecret: true } },
    });
  });

  it('replaces a masked SECRET value with the stored ${global:} binding', () => {
    const incoming: Record<string, MCPHeaderValue> = {
      'Authorization': { value: MASKED_STRING, metadata: { isSecret: true } },
    };
    const stored: Record<string, MCPHeaderValue> = {
      'Authorization': { value: '${global:TOKEN}', metadata: { isSecret: true } },
    };
    expect(hydrateMaskedHeaders(incoming, stored)).toEqual({
      'Authorization': { value: '${global:TOKEN}', metadata: { isSecret: true } },
    });
  });

  it('drops a masked SECRET value that has no stored counterpart', () => {
    const incoming: Record<string, MCPHeaderValue> = {
      'Authorization': { value: MASKED_API_KEY, metadata: { isSecret: true } },
    };
    expect(hydrateMaskedHeaders(incoming, undefined)).toEqual({});
    expect(hydrateMaskedHeaders(incoming, {})).toEqual({});
  });

  it('passes a NON-secret header whose literal value is "********" through unchanged', () => {
    const incoming: Record<string, MCPHeaderValue> = {
      'X-SAP-Client': { value: MASKED_API_KEY, metadata: { isSecret: false } },
    };
    expect(hydrateMaskedHeaders(incoming, undefined)).toEqual({
      'X-SAP-Client': { value: MASKED_API_KEY, metadata: { isSecret: false } },
    });
  });

  it('passes plaintext / ${global:} / encrypted secret values through unchanged', () => {
    const incoming: Record<string, MCPHeaderValue> = {
      'Authorization': { value: 'Bearer freshly-typed', metadata: { isSecret: true } },
      'X-Api-Key': { value: '${global:KEY}', metadata: { isSecret: true } },
      'X-Token': { value: 'encrypted:zzz', metadata: { isSecret: true } },
    };
    expect(hydrateMaskedHeaders(incoming, { 'Authorization': { value: 'encrypted:old', metadata: { isSecret: true } } }))
      .toEqual(incoming);
  });

  it('hydrates a legacy plain-string masked Authorization header (secret inferred from the key)', () => {
    const incoming = { 'Authorization': MASKED_API_KEY } as Record<string, MCPHeaderValue>;
    const stored: Record<string, MCPHeaderValue> = {
      'Authorization': { value: 'encrypted:abc', metadata: { isSecret: true } },
    };
    expect(hydrateMaskedHeaders(incoming, stored)).toEqual({
      'Authorization': { value: 'encrypted:abc', metadata: { isSecret: true } },
    });
  });

  it('returns undefined for undefined incoming headers', () => {
    expect(hydrateMaskedHeaders(undefined, {})).toBeUndefined();
  });
});
