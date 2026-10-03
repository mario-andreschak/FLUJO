'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskFlujoPageContext, AskFlujoUiAction, AskFlujoActionResult } from '@/frontend/types/askFlujo';
import { getSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import { AVATAR_PANEL_PROTOCOL, panelRoute } from './AvatarPanelBridge';
import type { WorldLocale } from './copy';
import { DEFAULT_LOCALE } from '@/vendor/avatar/client/locale';

export function useWorldPanel(onAsk: () => void, locale: WorldLocale = DEFAULT_LOCALE) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ready = useRef(false);
  const queued = useRef<string | null>(null);
  const pending = useRef(new Map<string, { resolve: (value: unknown) => void; timeout: ReturnType<typeof setTimeout> }>());
  const askRef = useRef(onAsk); askRef.current = onAsk;
  const localeRef = useRef(locale); localeRef.current = locale;
  const request = useCallback((action: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    if (!ready.current || !iframeRef.current?.contentWindow) return Promise.resolve(null);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timeout = setTimeout(() => { pending.current.delete(id); resolve(null); }, 3000);
      pending.current.set(id, { resolve, timeout });
      iframeRef.current?.contentWindow?.postMessage({ protocol: AVATAR_PANEL_PROTOCOL, workspace: getSelectedWorkspace(), id, action, ...extra }, window.location.origin);
    });
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow || event.data?.protocol !== AVATAR_PANEL_PROTOCOL || event.data.workspace !== getSelectedWorkspace()) return;
      if (event.data.ready) {
        ready.current = true;
        void request('locale', { locale: localeRef.current });
        if (queued.current) { void request('navigate', { path: queued.current }); queued.current = null; }
      }
      if (event.data.ask) askRef.current();
      const waiter = pending.current.get(event.data.id);
      if (waiter) { clearTimeout(waiter.timeout); pending.current.delete(event.data.id); waiter.resolve(event.data.value); }
    };
    window.addEventListener('message', receive);
    const waiters = pending.current;
    return () => { window.removeEventListener('message', receive); for (const waiter of waiters.values()) { clearTimeout(waiter.timeout); waiter.resolve(null); } waiters.clear(); };
  }, [request]);
  useEffect(() => { if (ready.current) void request('locale', { locale }); }, [locale, request]);
  const navigate = useCallback((path: string) => {
    const route = panelRoute(path, window.location.origin, getSelectedWorkspace());
    if (!route) return;
    setOpen(true);
    if (!src) { setSrc(route); queued.current = null; }
    else if (ready.current) void request('navigate', { path: route });
    else queued.current = route;
  }, [src, request]);
  return { iframeRef, src, open, navigate, close: () => setOpen(false),
    context: async (): Promise<AskFlujoPageContext | null> => open ? await request('context') as AskFlujoPageContext | null : null,
    apply: async (scopeId: string, proposal: AskFlujoUiAction): Promise<AskFlujoActionResult> => {
      const result = await request('apply', { scopeId, proposal }) as AskFlujoActionResult || { success: false, message: 'Open the original panel to apply this proposal.' };
      if (result.success) setOpen(true);
      return result;
    },
  };
}
