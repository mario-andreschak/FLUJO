import { runWithWorkspace } from '@/utils/workspace';
import { MCPOAuthClientProvider, matchesOAuthState } from '@/backend/services/mcp/oauth';

jest.mock('@/backend/services/registry/oauth-adapter', () => ({
  buildAuthorizeUrl: jest.fn(async ({ state }: { state: string }) => `https://registry.test/auth?state=${state}`),
  exchangeAuthorizationCode: jest.fn(async () => ({ status: 500, body: {} })),
}));

import {
  beginOAuth,
  completeOAuth,
  pendingOAuthWorkspace,
} from '@/backend/services/registry';

describe('OAuth workspace state', () => {
  it('uses an opaque MCP nonce bound to exactly one workspace', () => {
    const config = { name: 'server-a', transport: 'streamable' } as any;
    const provider = runWithWorkspace('team-a', () => new MCPOAuthClientProvider(
      config,
      'http://localhost/api/oauth/callback?workspace=team-a',
    ));
    const state = runWithWorkspace('team-a', () => provider.state());

    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toContain('server-a');
    expect(matchesOAuthState(config, state, 'team-a')).toBe(true);
    expect(matchesOAuthState(config, state, 'team-b')).toBe(false);
    expect(matchesOAuthState(config, `${state.slice(0, -1)}x`, 'team-a')).toBe(false);
  });

  it('binds registry state to one workspace and rejects cross-workspace completion', async () => {
    const { state } = await runWithWorkspace('team-a', () =>
      beginOAuth('github', 'http://localhost/api/registry/oauth/callback?workspace=team-a'),
    );
    expect(pendingOAuthWorkspace(state)).toBe('team-a');

    const mismatch = await runWithWorkspace('team-b', () => completeOAuth('code', state));
    expect(mismatch.status).toBe('error');
    // A forged callback must not consume the legitimate pending state.
    expect(pendingOAuthWorkspace(state)).toBe('team-a');
  });
});
