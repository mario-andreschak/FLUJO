import {
  hasMaskedStoredHeaders,
  hasStoredSecretHeaders,
  isSameMcpHeaderDestination,
} from '@/utils/mcp/headerDestination';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import type { MCPHeaderValue } from '@/shared/types/mcp/mcp';

const secret = (value: string): MCPHeaderValue => ({ value, metadata: { isSecret: true } });
const saved = { transport: 'streamable', serverUrl: 'https://saved.example/mcp?tenant=1' };

describe('saved MCP header destination', () => {
  it.each([
    'https://saved.example/mcp?tenant=1',
    'https://SAVED.example:443/mcp?tenant=1',
    'https://saved.example/mcp?tenant=1#editor',
  ])('allows equivalent HTTP request URLs: %s', (serverUrl) => {
    expect(isSameMcpHeaderDestination({ ...saved, serverUrl }, saved)).toBe(true);
  });

  it('normalizes an absent root path and the default HTTP port', () => {
    expect(isSameMcpHeaderDestination(
      { transport: 'sse', serverUrl: 'http://localhost:80/' },
      { transport: 'sse', serverUrl: 'http://localhost' },
    )).toBe(true);
  });

  it.each([
    'https://different.example/mcp?tenant=1',
    'http://saved.example/mcp?tenant=1',
    'https://saved.example:444/mcp?tenant=1',
    'https://saved.example/other?tenant=1',
    'https://saved.example/mcp?tenant=2',
    'https://saved.example/mcp/?tenant=1',
    'https://user:password@saved.example/mcp?tenant=1',
    'file:///mcp',
    '/mcp',
    'not a URL',
    '',
  ])('refuses reuse for a different or invalid destination: %s', (serverUrl) => {
    expect(isSameMcpHeaderDestination({ ...saved, serverUrl }, saved)).toBe(false);
  });

  it.each(['sse', 'stdio', 'websocket', undefined, null])('refuses transport change to %s', (transport) => {
    expect(isSameMcpHeaderDestination({ ...saved, transport }, saved)).toBe(false);
  });

  it('does not treat identical malformed saved URLs as a valid binding', () => {
    const invalid = { transport: 'streamable', serverUrl: 'not a URL' };
    expect(isSameMcpHeaderDestination(invalid, invalid)).toBe(false);
    expect(isSameMcpHeaderDestination(saved, undefined)).toBe(false);
    expect(isSameMcpHeaderDestination(saved, { ...saved, serverUrl: undefined })).toBe(false);
  });
});

describe('automatic saved header reuse', () => {
  it.each([MASKED_API_KEY, MASKED_STRING])('detects stored-value restoration for mask %s', (mask) => {
    expect(hasMaskedStoredHeaders({ Authorization: secret(mask) }, { Authorization: secret('encrypted:synthetic') })).toBe(true);
    expect(hasMaskedStoredHeaders({ Authorization: mask }, { Authorization: 'synthetic' })).toBe(true);
  });

  it('does not require a binding when there is no stored value to restore', () => {
    const incoming = { Authorization: secret(MASKED_API_KEY) };
    const records: (Record<string, MCPHeaderValue> | undefined)[] =
      [undefined, {}, { Authorization: secret('') }, { Authorization: secret(MASKED_STRING) }];
    for (const stored of records) {
      expect(hasMaskedStoredHeaders(incoming, stored)).toBe(false);
    }
  });

  it('allows explicit new values, bindings, ciphertext, clearing, and non-secret literal masks', () => {
    const stored = { Authorization: secret('encrypted:synthetic') };
    for (const value of ['fresh synthetic value', '${global:NEW_KEY}', 'encrypted:fresh', '']) {
      expect(hasMaskedStoredHeaders({ Authorization: secret(value) }, stored)).toBe(false);
    }
    expect(hasMaskedStoredHeaders({ Authorization: { value: MASKED_API_KEY, metadata: { isSecret: false } } }, stored)).toBe(false);
    expect(hasMaskedStoredHeaders({}, stored)).toBe(false);
  });

  it('detects implicit inheritance of stored secret values and references', () => {
    for (const value of ['encrypted:synthetic', '${global:KEY}', 'synthetic legacy value']) {
      expect(hasStoredSecretHeaders({ Authorization: secret(value) })).toBe(true);
      expect(hasStoredSecretHeaders({ Authorization: value })).toBe(true);
    }
  });

  it('allows implicit inheritance of only public, empty, or placeholder headers', () => {
    expect(hasStoredSecretHeaders(undefined)).toBe(false);
    expect(hasStoredSecretHeaders({ Accept: 'application/json' })).toBe(false);
    expect(hasStoredSecretHeaders({ Authorization: { value: 'public label', metadata: { isSecret: false } } })).toBe(false);
    expect(hasStoredSecretHeaders({ Authorization: secret('') })).toBe(false);
    expect(hasStoredSecretHeaders({ Authorization: secret(MASKED_API_KEY) })).toBe(false);
  });
});
