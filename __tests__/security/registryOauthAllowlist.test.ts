/**
 * Exact-path allow-list checks for the registry OAuth callback (issue #207).
 *
 * The callback must be publicly reachable (the hosted registry redirects the
 * browser to it cross-origin), but ONLY by its exact path — a sibling like
 * `...callback-evil` must never be opened, and the local-only `.../oauth/initiate`
 * must stay behind the fail-closed origin guard.
 */
import { isPublicApiPath } from '@/utils/http/publicApiAllowlist';

describe('registry OAuth allow-list (#207)', () => {
  it('allows the exact callback path', () => {
    expect(isPublicApiPath('/api/registry/oauth/callback')).toBe(true);
    // Trailing slash is normalized to the same path.
    expect(isPublicApiPath('/api/registry/oauth/callback/')).toBe(true);
  });

  it('does NOT allow a look-alike sibling path', () => {
    expect(isPublicApiPath('/api/registry/oauth/callback-evil')).toBe(false);
    expect(isPublicApiPath('/api/registry/oauth/callback/evil')).toBe(false);
  });

  it('keeps the initiate route local-only (not public)', () => {
    expect(isPublicApiPath('/api/registry/oauth/initiate')).toBe(false);
  });
});
