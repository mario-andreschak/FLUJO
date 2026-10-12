'use client';
import type { ReactNode } from 'react';
import { panelRoute } from './AvatarPanelBridge';

type WorldLinkDestination = { kind: 'panel' | 'external' | 'fragment'; href: string };

/** Guide links use the same panel/workspace boundary as the world landmarks. */
export function worldLinkDestination(href: string | undefined, origin: string, workspace: string): WorldLinkDestination | null {
  if (!href || href.length > 2048 || /[\\\u0000-\u001f]/.test(href)) return null;
  if (href.startsWith('#')) return { kind: 'fragment', href };
  try {
    const url = new URL(href, origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin !== origin) return { kind: 'external', href: url.href };
    const route = panelRoute(`${url.pathname}${url.search}${url.hash}`, origin, workspace);
    if (!route) return null;
    const destination = new URL(route, origin);
    // Copy/open-in-new-tab remains an ordinary Flujo page. The panel bridge
    // adds its embed flag only when the user opens the link inside the world.
    destination.searchParams.delete('avatarEmbed');
    return { kind: 'panel', href: `${destination.pathname}${destination.search}${destination.hash}` };
  } catch { return null; }
}

export default function WorldLink({ href, title, children, workspace, onNavigate, onOpen }: {
  href?: string; title?: string; children?: ReactNode; workspace: string; onNavigate: (path: string) => void; onOpen?: () => void;
}) {
  const destination = worldLinkDestination(href, typeof window === 'undefined' ? '' : window.location.origin, workspace);
  if (!destination) return <span>{children}</span>;
  if (destination.kind === 'external') return <a href={destination.href} title={title} target="_blank" rel="noopener noreferrer" onClick={() => onOpen?.()} onAuxClick={event => { if (event.button === 1) onOpen?.(); }}>{children}</a>;
  return <a href={destination.href} title={title} onAuxClick={event => { if (destination.kind === 'panel' && event.button === 1) onOpen?.(); }} onClick={event => {
    if (destination.kind !== 'panel' || event.defaultPrevented || event.button !== 0) return;
    onOpen?.();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onNavigate(destination.href);
  }}>{children}</a>;
}
