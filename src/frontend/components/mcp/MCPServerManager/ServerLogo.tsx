'use client';

import React, { useEffect, useState } from 'react';
import { Avatar, alpha, useTheme } from '@mui/material';
import type { MCPServerConfig, MCPServerIcon } from '@/shared/types/mcp';

const BUNDLED_ICON_BY_PACKAGE: Record<string, string> = {
  '@mario.andreschak/mcp-flujo': '/mcp-icons/flujo.svg',
  '@mario.andreschak/mcp-filesystem': '/mcp-icons/filesystem.svg',
  '@mario.andreschak/mcp-bash': '/mcp-icons/bash.svg',
  '@mario.andreschak/mcp-browser': '/mcp-icons/browser.svg',
  // Package IDs used by FLUJO before the standalone servers moved scopes.
  '@flujo-ai/mcp-flujo': '/mcp-icons/flujo.svg',
  '@flujo-ai/mcp-filesystem': '/mcp-icons/filesystem.svg',
  '@flujo-ai/mcp-bash': '/mcp-icons/bash.svg',
  '@flujo-ai/mcp-browser': '/mcp-icons/browser.svg',
};

const registryIconCache = new Map<string, MCPServerIcon[] | null>();
const registryIconRequests = new Map<string, Promise<MCPServerIcon[] | null>>();

function normalizeRegistryIcons(value: unknown): MCPServerIcon[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const icon = candidate as Record<string, unknown>;
    if (typeof icon.src !== 'string' || !isSafeIconSource(icon.src)) return [];
    return [{
      src: icon.src,
      ...(Array.isArray(icon.sizes) && icon.sizes.every(size => typeof size === 'string')
        ? { sizes: icon.sizes as string[] }
        : {}),
      ...(typeof icon.mimeType === 'string' ? { mimeType: icon.mimeType } : {}),
      ...(icon.theme === 'light' || icon.theme === 'dark' ? { theme: icon.theme } : {}),
    }];
  });
}

async function discoverRegistryIcons(registryName: string): Promise<MCPServerIcon[] | null> {
  if (registryIconCache.has(registryName)) return registryIconCache.get(registryName) ?? null;
  const pending = registryIconRequests.get(registryName);
  if (pending) return pending;

  const request = fetch(
    `/api/mcp-registry?search=${encodeURIComponent(registryName)}&limit=10&iconsOnly=true`,
  )
    .then(async response => response.ok ? response.json() : null)
    .then(data => {
      const results = Array.isArray(data?.servers) ? data.servers : [];
      const exact = results.find(
        (result: unknown) => {
          if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
          const server = (result as { server?: unknown }).server;
          return Boolean(
            server
            && typeof server === 'object'
            && !Array.isArray(server)
            && (server as { name?: unknown }).name === registryName,
          );
        },
      ) as { server?: { icons?: unknown } } | undefined;
      const icons = normalizeRegistryIcons(exact?.server?.icons);
      const resolved = icons.length > 0 ? icons : null;
      registryIconCache.set(registryName, resolved);
      return resolved;
    })
    .catch(() => {
      registryIconCache.set(registryName, null);
      return null;
    })
    .finally(() => registryIconRequests.delete(registryName));

  registryIconRequests.set(registryName, request);
  return request;
}

function serverMonogram(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0] || 'MCP').slice(0, 2).toUpperCase();
}

function serverHue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) - hash + name.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function isSafeIconSource(src: string): boolean {
  if (src.startsWith('/')) return !src.startsWith('//');
  try {
    return /^https?:$/.test(new URL(src).protocol);
  } catch {
    return false;
  }
}

export function resolveServerLogo(
  config: MCPServerConfig | undefined,
  mode: 'light' | 'dark',
): string | null {
  const source = config?.source;
  const bundled = source?.type === 'marketplace'
    ? BUNDLED_ICON_BY_PACKAGE[source.id]
    : undefined;
  const safeIcons = normalizeRegistryIcons(config?.icons);
  const themed = safeIcons.find((icon) => icon.theme === mode);
  const neutral = safeIcons.find((icon) => !icon.theme);
  return themed?.src ?? neutral?.src ?? safeIcons[0]?.src ?? bundled ?? null;
}

interface ServerLogoProps {
  name: string;
  config?: MCPServerConfig;
  size?: number;
}

const ServerLogo: React.FC<ServerLogoProps> = ({ name, config, size = 48 }) => {
  const theme = useTheme();
  const registryName = config?.source?.type === 'registry'
    ? config.source.registryName
    : undefined;
  const [discovered, setDiscovered] = useState<{
    registryName: string;
    icons: MCPServerIcon[] | null;
  } | null>(
    () => registryName && registryIconCache.has(registryName)
      ? { registryName, icons: registryIconCache.get(registryName) ?? null }
      : null,
  );
  const configuredIcons = normalizeRegistryIcons(config?.icons);
  const discoveredIcons = discovered && discovered.registryName === registryName
    ? discovered.icons
    : null;
  const logoConfig = configuredIcons.length
    ? { ...config, icons: configuredIcons } as MCPServerConfig
    : discoveredIcons?.length
      ? { ...config, icons: discoveredIcons } as MCPServerConfig
      : config;
  const logo = resolveServerLogo(logoConfig, theme.palette.mode);
  const hue = serverHue(name);

  useEffect(() => {
    if (!registryName || configuredIcons.length) return;
    let active = true;
    void discoverRegistryIcons(registryName).then(icons => {
      if (active) setDiscovered({ registryName, icons });
    });
    return () => { active = false; };
  }, [configuredIcons.length, registryName]);

  return (
    <Avatar
      src={logo ?? undefined}
      alt=""
      aria-hidden="true"
      variant="rounded"
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: `${Math.round(size * 0.29)}px`,
        color: logo ? 'primary.main' : '#fff',
        bgcolor: logo
          ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.16 : 0.1)
          : undefined,
        background: logo
          ? undefined
          : `linear-gradient(145deg, hsl(${hue} 66% 59%), hsl(${(hue + 34) % 360} 65% 43%))`,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.16)}`,
        boxShadow: `0 10px 28px ${alpha(theme.palette.primary.main, 0.16)}`,
        fontWeight: 760,
        letterSpacing: '-0.04em',
        '& img': { objectFit: 'cover' },
      }}
    >
      {serverMonogram(name)}
    </Avatar>
  );
};

export default ServerLogo;
