import { resolveServerLogo } from '@/frontend/components/mcp/MCPServerManager/ServerLogo';
import type { MCPServerConfig, MCPServerIcon, MCPServerSource } from '@/shared/types/mcp';

function configWith(
  source: MCPServerSource,
  icons?: MCPServerIcon[],
): MCPServerConfig {
  return { source, ...(icons ? { icons } : {}) } as MCPServerConfig;
}

describe('resolveServerLogo', () => {
  it.each([
    ['@mario.andreschak/mcp-flujo', '/mcp-icons/flujo.svg'],
    ['@mario.andreschak/mcp-filesystem', '/mcp-icons/filesystem.svg'],
    ['@mario.andreschak/mcp-bash', '/mcp-icons/bash.svg'],
    ['@mario.andreschak/mcp-browser', '/mcp-icons/browser.svg'],
    ['@flujo-ai/mcp-flujo', '/mcp-icons/flujo.svg'],
    ['@flujo-ai/mcp-filesystem', '/mcp-icons/filesystem.svg'],
    ['@flujo-ai/mcp-bash', '/mcp-icons/bash.svg'],
    ['@flujo-ai/mcp-browser', '/mcp-icons/browser.svg'],
  ])('resolves bundled package alias %s', (packageId, expected) => {
    const config = configWith({ type: 'marketplace', id: packageId });

    expect(resolveServerLogo(config, 'light')).toBe(expected);
    expect(resolveServerLogo(config, 'dark')).toBe(expected);
  });

  it('prefers the registry icon matching the active theme', () => {
    const config = configWith(
      { type: 'registry', registryName: 'io.example/weather' },
      [
        { src: 'https://example.com/neutral.svg' },
        { src: 'https://example.com/light.svg', theme: 'light' },
        { src: 'https://example.com/dark.svg', theme: 'dark' },
      ],
    );

    expect(resolveServerLogo(config, 'light')).toBe('https://example.com/light.svg');
    expect(resolveServerLogo(config, 'dark')).toBe('https://example.com/dark.svg');
  });

  it('uses neutral, then first safe icon as deterministic fallbacks', () => {
    const neutralConfig = configWith(
      { type: 'registry', registryName: 'io.example/neutral' },
      [
        { src: 'javascript:alert(1)', theme: 'light' },
        { src: 'https://example.com/dark.svg', theme: 'dark' },
        { src: 'https://example.com/neutral.svg' },
      ],
    );
    const oppositeThemeConfig = configWith(
      { type: 'registry', registryName: 'io.example/opposite' },
      [
        { src: 'data:image/svg+xml;base64,AAAA', theme: 'light' },
        { src: 'https://example.com/dark-first.svg', theme: 'dark' },
        { src: 'https://example.com/dark-second.svg', theme: 'dark' },
      ],
    );

    expect(resolveServerLogo(neutralConfig, 'light')).toBe('https://example.com/neutral.svg');
    expect(resolveServerLogo(oppositeThemeConfig, 'light')).toBe(
      'https://example.com/dark-first.svg',
    );
  });

  it('falls back to the bundled logo after rejecting unsafe configured icons', () => {
    const config = configWith(
      { type: 'marketplace', id: '@mario.andreschak/mcp-bash' },
      [{ src: 'file:///tmp/untrusted.svg' }],
    );

    expect(resolveServerLogo(config, 'dark')).toBe('/mcp-icons/bash.svg');
  });

  it('returns null when no safe or bundled logo exists', () => {
    const config = configWith(
      { type: 'local' },
      [{ src: 'data:image/svg+xml;base64,AAAA' }],
    );

    expect(resolveServerLogo(config, 'light')).toBeNull();
  });

  it('treats malformed persisted icon metadata as absent', () => {
    const config = {
      source: { type: 'local' },
      icons: { src: 'https://example.com/not-an-array.svg' },
    } as unknown as MCPServerConfig;

    expect(resolveServerLogo(config, 'light')).toBeNull();
  });
});
