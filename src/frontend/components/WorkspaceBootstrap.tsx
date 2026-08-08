"use client";

import React, { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_WORKSPACE,
  getSelectedWorkspace,
  initializeWorkspaceSelection,
  isValidWorkspaceName,
  readWorkspacePageRequest,
  setSelectedWorkspace,
  workspacePageUrl,
} from '@/frontend/utils/workspaceSelection';
import { migrateLegacyBrowserWorkspaceContent } from '@/frontend/utils/workspaceContentKeys';

interface WorkspaceBootstrapProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Gate every data-bearing provider/page behind workspace selection bootstrap.
 * The interceptor and storage listener install during render; children mount
 * only after the active name is confirmed against the installation-wide
 * workspace list. A top-level workspace deep link is frozen for request routing,
 * validated and persisted before providers mount, so linked content cannot open
 * in a stale tab selection even when browser storage is unavailable.
 */
export default function WorkspaceBootstrap({ children, fallback = null }: WorkspaceBootstrapProps) {
  initializeWorkspaceSelection();
  migrateLegacyBrowserWorkspaceContent();
  const pageRequestOnMount = useRef(readWorkspacePageRequest());
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('Workspace discovery is not ready.');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt += 1) {
        try {
          const response = await fetch('/api/workspaces', { cache: 'no-store' });
          if (!response.ok) throw new Error(`Workspace discovery failed (${response.status})`);
          const payload = (await response.json()) as { workspaces?: Array<{ name?: unknown }> };
          const names = new Set(
            (Array.isArray(payload.workspaces) ? payload.workspaces : [])
              .map(item => item?.name)
              .filter(isValidWorkspaceName),
          );
          const selected = getSelectedWorkspace();
          const pageRequest = pageRequestOnMount.current;
          if (pageRequest.kind === 'invalid') {
            if (!cancelled) {
              setErrorMessage('The workspace in this link is invalid.');
              setStatus('error');
            }
            return;
          }

          const requested = pageRequest.kind === 'valid' ? pageRequest.workspace : selected;
          if (!names.has(requested)) {
            if (pageRequest.kind === 'valid') {
              if (!cancelled) {
                setErrorMessage(`Unknown workspace: ${requested}`);
                setStatus('error');
              }
              return;
            }
            setSelectedWorkspace(DEFAULT_WORKSPACE);
            window.location.assign(workspacePageUrl(DEFAULT_WORKSPACE));
            return;
          }

          // initializeWorkspaceSelection froze a valid top-level deep link as
          // this tab's request workspace before providers mounted. Discovery
          // has now confirmed it exists, so persist it as the next-load/default
          // preference. No reload is needed (or safe when storage is blocked).
          if (pageRequest.kind === 'valid') {
            setSelectedWorkspace(requested);
          }

          if (!cancelled) setStatus('ready');
          return;
        } catch {
          if (attempt < 3) {
            await new Promise(resolve => window.setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
      }
      // Fail closed: mounting data providers here would let them fall back or
      // issue a storm of 404s while migration/readiness is uncertain.
      if (!cancelled) setStatus('error');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'ready') return <>{children}</>;
  if (status === 'error') {
    return (
      <div className="app-loading" role="alert">
        <div className="app-loading__content">
          <span>{errorMessage}</span>
          <button type="button" onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }
  return <>{fallback}</>;
}
