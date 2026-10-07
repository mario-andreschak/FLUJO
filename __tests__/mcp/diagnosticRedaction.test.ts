import {
  collectMcpDiagnosticSecrets,
  createMcpDiagnosticRedactor,
} from '@/utils/mcp/diagnosticRedaction';
import type { MCPServerConfig } from '@/shared/types/mcp/mcp';

describe('MCP diagnostic credential redaction', () => {
  const token = 'synthetic-opaque-$&-[credential]';
  it('collects resolved secrets using pre-resolution metadata and legacy auth names', () => {
    const configured = {
      env: { CUSTOM: { value: '${global:CUSTOM}', metadata: { isSecret: true } } },
      headers: { Authorization: '********', 'X-Opaque': { value: 'ciphertext', metadata: { isSecret: true } } },
    } as unknown as MCPServerConfig;
    const resolved = {
      env: { CUSTOM: token },
      headers: { Authorization: `Bearer ${token}`, 'X-Opaque': 'another-synthetic-secret' },
    } as unknown as MCPServerConfig;
    const secrets = collectMcpDiagnosticSecrets(configured, resolved);
    expect(secrets).toEqual(expect.arrayContaining([token, `Bearer ${token}`, 'another-synthetic-secret']));
    expect(secrets).not.toContain('********');
    expect(secrets).not.toContain('${global:CUSTOM}');
  });
  it('redacts repeated literal, URL and JSON forms without changing TLS or timeout guidance', () => {
    const { redact } = createMcpDiagnosticRedactor([token]);
    const message = `HTTP 401 ${token} ${token} ${encodeURIComponent(token)}; UNABLE_TO_VERIFY_LEAF_SIGNATURE; Connection timeout after 15s`;
    expect(redact(message)).toBe('HTTP 401 [REDACTED] [REDACTED] [REDACTED]; UNABLE_TO_VERIFY_LEAF_SIGNATURE; Connection timeout after 15s');
    const quoted = 'synthetic-"credential"';
    expect(createMcpDiagnosticRedactor([quoted]).redact(JSON.stringify(quoted))).toBe('"[REDACTED]"');
  });
  it('redacts every possible split while emitting ordinary text immediately', () => {
    for (let split = 1; split < token.length; split++) {
      const stream = createMcpDiagnosticRedactor([token]).stream();
      expect(stream.write('server: ready\n')).toBe('server: ready\n');
      const first = stream.write(`rejected ${token.slice(0, split)}`);
      expect(first).toBe('rejected ');
      expect(first + stream.write(`${token.slice(split)}\n`) + stream.end()).toBe('rejected [REDACTED]\n');
    }
  });
  it('handles overlapping credentials and masks a truncated terminal prefix', () => {
    const stream = createMcpDiagnosticRedactor(['synthetic', 'synthetic-long-secret']).stream();
    expect(stream.write('synthetic')).toBe('');
    expect(stream.write('-long-secret\n') + stream.end()).toBe('[REDACTED]\n');
    const truncated = createMcpDiagnosticRedactor([token]).stream();
    expect(truncated.write(token.slice(0, 8))).toBe('');
    expect(truncated.end()).toBe('[REDACTED]');
  });
  it('preserves diagnostics when no credentials are configured, including non-secret env', () => {
    const configured = { env: { PATH: '/synthetic/tools' } } as unknown as MCPServerConfig;
    const secrets = collectMcpDiagnosticSecrets(configured, configured);
    expect(secrets).toEqual([]);
    const stream = createMcpDiagnosticRedactor(secrets).stream();
    expect(stream.write('download 25%')).toBe('download 25%');
    expect(stream.end()).toBe('');
  });
});

it('skips malformed nullable/non-string credential entries as the resolver does', () => {
  const configured = {
    env: { API_KEY: null, TOKEN: { value: 123, metadata: { isSecret: true } }, SECRET: 'synthetic-valid' },
    headers: { Authorization: null },
  } as unknown as MCPServerConfig;
  const resolved = { env: { SECRET: 'synthetic-valid' }, headers: {} } as unknown as MCPServerConfig;
  expect(collectMcpDiagnosticSecrets(configured, resolved)).toEqual(['synthetic-valid']);
});
