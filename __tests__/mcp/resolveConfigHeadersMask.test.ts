/**
 * Defensive-guard regression test for resolveConfigHeaders (issue #137).
 *
 * resolveConfigHeaders must NEVER forward the mask placeholder (`********`) as a literal
 * header value. Even though testConnection now hydrates masked SECRET headers from the
 * stored config before calling this, a value that is still masked at this point (e.g. a
 * masked secret with no stored counterpart) must be dropped so the literal `********` can
 * never reach a remote server (which rejected it as "Authorization Token badly formatted").
 */

// resolveConfigHeaders delegates plaintext/global/encrypted resolution to
// resolveAndDecryptApiKey; stub it to identity so this test isolates the mask guard and
// does not depend on the encryption lock / global-var store.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveAndDecryptApiKey: jest.fn(async (v: string) => v),
}));

import { resolveConfigHeaders } from '@/backend/services/mcp/connection';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';
import { MASKED_API_KEY, MASKED_STRING } from '@/shared/types/constants';
import type { MCPServerConfig } from '@/shared/types/mcp';

describe('resolveConfigHeaders — mask guard (#137)', () => {
  beforeEach(() => {
    (resolveAndDecryptApiKey as jest.Mock).mockImplementation(async (v: string) => v);
  });

  it('drops a still-masked secret header and never forwards the placeholder', async () => {
    const config = {
      name: 'gh',
      transport: 'streamable',
      serverUrl: 'http://localhost:3001',
      headers: {
        Authorization: { value: MASKED_API_KEY, metadata: { isSecret: true } },
        'X-Api-Key': { value: MASKED_STRING, metadata: { isSecret: true } },
        'X-SAP-Client': { value: '100', metadata: { isSecret: false } },
      },
      disabled: false,
    } as unknown as MCPServerConfig;

    const resolved = (await resolveConfigHeaders(config)) as unknown as {
      headers: Record<string, string>;
    };

    // Masked secrets dropped; the ordinary header survives.
    expect(resolved.headers).toEqual({ 'X-SAP-Client': '100' });
    expect(JSON.stringify(resolved.headers)).not.toContain(MASKED_API_KEY);
  });

  it('forwards a real (non-masked) header value unchanged', async () => {
    const config = {
      name: 'gh',
      transport: 'sse',
      serverUrl: 'http://localhost:3001',
      headers: {
        Authorization: { value: 'Bearer real-token', metadata: { isSecret: true } },
      },
      disabled: false,
    } as unknown as MCPServerConfig;

    const resolved = (await resolveConfigHeaders(config)) as unknown as {
      headers: Record<string, string>;
    };

    expect(resolved.headers).toEqual({ Authorization: 'Bearer real-token' });
  });

  it('resolves env global bindings only in the temporary connection config', async () => {
    (resolveAndDecryptApiKey as jest.Mock).mockImplementation(async (value: string) =>
      value === '${global:GITHUB_TOKEN}' ? 'resolved-token' : value
    );
    const config = {
      name: 'github',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {
        GITHUB_TOKEN: {
          value: '${global:GITHUB_TOKEN}',
          metadata: { isSecret: true },
        },
        MODE: 'safe',
      },
      disabled: false,
    } as unknown as MCPServerConfig;

    const resolved = await resolveConfigHeaders(config);

    expect(resolved.env).toEqual({
      GITHUB_TOKEN: 'resolved-token',
      MODE: 'safe',
    });
    // The persisted/source config remains a portable reference.
    expect(config.env.GITHUB_TOKEN).toEqual({
      value: '${global:GITHUB_TOKEN}',
      metadata: { isSecret: true },
    });
  });
});
