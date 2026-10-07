'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { NativeVoiceTransport } from '@/vendor/avatar/client/nativeVoiceTransport';
import { bindPhoneHostRequests, initializeWorkspaceSelection, readWorkspacePageRequest, setSelectedWorkspace, workspacePageUrl } from '@/frontend/utils/workspaceSelection';
import { createPhoneVoiceTransport, readPhoneVoiceSession, unavailablePhoneVoiceTransport, type PhoneVoiceSession } from './AvatarWorld/phoneVoiceTransport';

const PhoneHostContext = createContext<NativeVoiceTransport | null>(null);
export const usePhoneHostVoice = () => useContext(PhoneHostContext);

export default function PhoneHostBoundary({ enabled, children, fallback = null }: { enabled: boolean; children: ReactNode; fallback?: ReactNode }) {
  return enabled ? <AdmittedPhoneHost fallback={fallback}>{children}</AdmittedPhoneHost> : children;
}

/** Admission precedes WorkspaceBootstrap and every data-bearing provider/frame. */
function AdmittedPhoneHost({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [transport, setTransport] = useState<NativeVoiceTransport | null>(null);
  useEffect(() => {
    let disposed = false, generation = 0;
    let lookup: AbortController | undefined;
    let active: { session: PhoneVoiceSession; lifetime: AbortController; ready: boolean } | undefined;
    bindPhoneHostRequests();
    const retire = () => {
      active?.lifetime.abort(); active = undefined; bindPhoneHostRequests();
      if (!disposed) setTransport(null);
    };
    const refresh = async () => {
      const current = ++generation;
      lookup?.abort();
      const request = new AbortController(); lookup = request;
      try {
        const response = await fetch('/phone/session', {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        });
        const session = await readPhoneVoiceSession(response);
        if (disposed || request.signal.aborted || current !== generation) return;
        const page = readWorkspacePageRequest();
        if (page.kind !== 'valid' || page.workspace !== session.nativeWorkspace) {
          retire(); setSelectedWorkspace(session.nativeWorkspace);
          window.location.replace(workspacePageUrl(session.nativeWorkspace)); return;
        }
        if (active?.ready && !active.lifetime.signal.aborted && active.session.voiceScopeKey === session.voiceScopeKey && active.session.csrf === session.csrf
          && active.session.nativeWorkspace === session.nativeWorkspace) return;
        active?.lifetime.abort();
        const lifetime = new AbortController();
        active = { session, lifetime, ready: false };
        const accessEnded = () => { if (active?.lifetime === lifetime) retire(); };
        bindPhoneHostRequests({ csrf: session.csrf, workspace: session.nativeWorkspace, signal: lifetime.signal, onAccessEnded: accessEnded });
        setSelectedWorkspace(session.nativeWorkspace);
        initializeWorkspaceSelection();
        // During rotation keep the existing provider/controller tree mounted.
        setTransport(previous => previous ? unavailablePhoneVoiceTransport : null);
        const next = await createPhoneVoiceTransport(session, lifetime.signal, accessEnded);
        if (disposed || request.signal.aborted || current !== generation) { lifetime.abort(); return; }
        if (active?.lifetime !== lifetime || lifetime.signal.aborted) return;
        active.ready = true;
        setTransport(next);
      } catch {
        if (!disposed && !request.signal.aborted && current === generation) retire();
      }
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const timer = setInterval(visible, 15000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true; generation++; lookup?.abort(); retire(); clearInterval(timer);
      window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return transport ? <PhoneHostContext.Provider value={transport}>{children}</PhoneHostContext.Provider> : fallback;
}
