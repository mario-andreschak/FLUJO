import { deriveVerifiedMcpAppOriginKey } from '@/backend/mcpApps/appOrigin';
import { isValidMcpAppDomain } from '@/shared/utils/mcpAppOrigin';

describe('verified MCP App browser origin identity', () => {
  const identity = {
    workspace: 'workspace-a',
    serverName: 'acme',
    uri: 'ui://acme/dashboard',
  };

  it('is a stable single DNS label derived with SHA-256', () => {
    const first = deriveVerifiedMcpAppOriginKey(identity);
    const second = deriveVerifiedMcpAppOriginKey({ ...identity });

    expect(first).toBe(second);
    expect(first).toMatch(/^app[0-9a-f]{60}$/);
    expect(first).toHaveLength(63);
    expect(isValidMcpAppDomain(first)).toBe(true);
  });

  it.each([
    ['workspace', { ...identity, workspace: 'workspace-b' }],
    ['server', { ...identity, serverName: 'other-server' }],
    ['exact opaque URI', { ...identity, uri: 'ui://acme/dashboard/' }],
  ])('partitions a different %s', (_label, other) => {
    expect(deriveVerifiedMcpAppOriginKey(other))
      .not.toBe(deriveVerifiedMcpAppOriginKey(identity));
  });

  it('does not permit an ambiguous tuple or an incomplete identity', () => {
    expect(deriveVerifiedMcpAppOriginKey({
      workspace: 'ab', serverName: 'c', uri: 'd',
    })).not.toBe(deriveVerifiedMcpAppOriginKey({
      workspace: 'a', serverName: 'bc', uri: 'd',
    }));
    expect(() => deriveVerifiedMcpAppOriginKey({
      ...identity, workspace: '',
    })).toThrow(/required/);
  });
});
