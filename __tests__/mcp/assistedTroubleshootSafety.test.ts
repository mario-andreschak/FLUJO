import {
  sanitizeMcpDiagnosticText,
  validateMcpTroubleshootPatch,
} from '@/backend/services/mcp/assistedInstall';

describe('MCP assisted troubleshooting safety', () => {
  it('redacts common bearer, API-key, and JSON secret forms before AI diagnosis', () => {
    const sanitized = sanitizeMcpDiagnosticText([
      'Authorization: Bearer abc.def.secret',
      'API_KEY=super-private-value',
      '{"token":"another-private-value"}',
      'ghp_1234567890abcdefghijklmnop',
    ].join('\n'));

    expect(sanitized).not.toContain('abc.def.secret');
    expect(sanitized).not.toContain('super-private-value');
    expect(sanitized).not.toContain('another-private-value');
    expect(sanitized).not.toContain('ghp_1234567890abcdefghijklmnop');
    expect(sanitized).toContain('[REDACTED]');
  });

  it('keeps only allowlisted patch fields and safe web URLs/input names', () => {
    const patch = validateMcpTroubleshootPatch({
      command: 'npx',
      args: ['-y', '@example/server'],
      serverUrl: 'javascript:alert(1)',
      addEnvNames: ['API_KEY', 'bad name=value'],
      addHeaderNames: ['Authorization', 'Header: injected'],
      token: 'must-not-pass',
    });

    expect(patch).toEqual({
      command: 'npx',
      args: ['-y', '@example/server'],
      addEnvNames: ['API_KEY'],
      addHeaderNames: ['Authorization'],
    });
    expect(JSON.stringify(patch)).not.toContain('must-not-pass');
    expect(JSON.stringify(patch)).not.toContain('javascript:');
  });
});
