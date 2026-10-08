import {
  deriveVerifiedMcpAppOriginKey,
  MCP_APP_ORIGIN_NAMESPACE_ENV,
} from '@/backend/mcpApps/appOrigin';
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

  it('partitions identical App identities by deployment namespace without changing the label shape', () => {
    const brainA = deriveVerifiedMcpAppOriginKey({ ...identity, namespace: 'brain-a' });
    const brainB = deriveVerifiedMcpAppOriginKey({ ...identity, namespace: 'brain-b' });

    expect(brainA).not.toBe(brainB);
    expect(brainA).toMatch(/^app[0-9a-f]{60}$/);
    expect(brainB).toMatch(/^app[0-9a-f]{60}$/);
  });

  it('uses FLUJO_MCP_APP_ORIGIN_NAMESPACE while preserving the legacy empty default', () => {
    const previous = process.env[MCP_APP_ORIGIN_NAMESPACE_ENV];
    try {
      delete process.env[MCP_APP_ORIGIN_NAMESPACE_ENV];
      const legacy = deriveVerifiedMcpAppOriginKey(identity);
      expect(deriveVerifiedMcpAppOriginKey({ ...identity, namespace: '' })).toBe(legacy);

      process.env[MCP_APP_ORIGIN_NAMESPACE_ENV] = 'brain-env';
      expect(deriveVerifiedMcpAppOriginKey(identity)).toBe(
        deriveVerifiedMcpAppOriginKey({ ...identity, namespace: 'brain-env' }),
      );
      expect(deriveVerifiedMcpAppOriginKey(identity)).not.toBe(legacy);
    } finally {
      if (previous === undefined) delete process.env[MCP_APP_ORIGIN_NAMESPACE_ENV];
      else process.env[MCP_APP_ORIGIN_NAMESPACE_ENV] = previous;
    }
  });
});
