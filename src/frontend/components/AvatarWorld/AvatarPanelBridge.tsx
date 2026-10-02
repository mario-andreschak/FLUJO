'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAskFlujo } from '@/frontend/contexts/AskFlujoContext';
import { getSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import type { AskFlujoUiAction } from '@/frontend/types/askFlujo';
import { interceptNavigation } from '@/frontend/utils/navigationGuard';
import { useI18n } from '@/frontend/contexts/I18nContext';

export const AVATAR_PANEL_PROTOCOL = 'flujo-avatar-panel-v1';
const ROUTES = ['/models', '/mcp', '/flows', '/personas', '/roles', '/meetings', '/automation', '/executions', '/waves', '/packages', '/chat', '/settings', '/statistics', '/docs'];

export function panelRoute(path: unknown, origin: string, workspace: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 2048 || /[\\\u0000-\u001f]/.test(path)) return null;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || !ROUTES.some(route => url.pathname === route || url.pathname.startsWith(`${route}/`))) return null;
    if (url.searchParams.has('workspace') && url.searchParams.get('workspace') !== workspace) return null;
    url.searchParams.set('workspace', workspace);
    url.searchParams.set('avatarEmbed', '1');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

/** Trusted Flujo panel bridge. MCP Apps retain their existing sandbox/frame host. */
export default function AvatarPanelBridge() {
  const router = useRouter();
  const { setLocale } = useI18n();
  const { getPageContext, applyPageAction, open, closeDock } = useAskFlujo();
  useEffect(() => {
    const reply = (id: string, value: unknown) => window.parent.postMessage({ protocol: AVATAR_PANEL_PROTOCOL, workspace: getSelectedWorkspace(), id, value }, window.location.origin);
    const receive = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.protocol !== AVATAR_PANEL_PROTOCOL || event.data.workspace !== getSelectedWorkspace()
        || typeof event.data.id !== 'string' || event.data.id.length > 128) return;
      const { id, action } = event.data;
      if (action === 'context') reply(id, getPageContext());
      if (action === 'locale' && ['es', 'pt', 'en'].includes(event.data.locale)) { setLocale(event.data.locale); reply(id, { success: true }); }
      if (action === 'navigate') {
        const route = panelRoute(event.data.path, window.location.origin, getSelectedWorkspace());
        if (!route) { reply(id, { success: false }); return; }
        const navigate = () => { router.push(route); reply(id, { success: true }); };
        if (!interceptNavigation(navigate)) navigate();
      }
      if (action === 'apply') {
        const current = getPageContext();
        if (current.scopeId !== event.data.scopeId) { reply(id, { success: false, message: 'The original panel is no longer open.' }); return; }
        const proposal = event.data.proposal as AskFlujoUiAction | undefined;
        if (!proposal || !['highlight', 'set_value'].includes(proposal.type)) return;
        reply(id, await applyPageAction(proposal));
      }
    };
    window.addEventListener('message', receive);
    window.parent.postMessage({ protocol: AVATAR_PANEL_PROTOCOL, workspace: getSelectedWorkspace(), ready: true }, window.location.origin);
    return () => window.removeEventListener('message', receive);
  }, [getPageContext, applyPageAction, router, setLocale]);
  useEffect(() => {
    if (open) {
      window.parent.postMessage({ protocol: AVATAR_PANEL_PROTOCOL, workspace: getSelectedWorkspace(), ask: true }, window.location.origin);
      closeDock();
    }
  }, [open, closeDock]);
  return null;
}
