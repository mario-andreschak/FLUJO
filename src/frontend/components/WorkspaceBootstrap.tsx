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
  const [status, setStatus] = useState<'loading' | 'migrating' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState('Workspace discovery is not ready.');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let transientFailures = 0;
      while (!cancelled) {
        try {
          const response = await fetch('/api/workspaces', { cache: 'no-store' });
          const payload = (await response.json()) as {
            workspaces?: Array<{ name?: unknown }>;
            code?: unknown;
          };
          if (response.status === 503 && payload.code === 'WORKSPACE_LAYOUT_PREPARING') {
            transientFailures = 0;
            if (!cancelled) setStatus('migrating');
            const retrySeconds = Number(response.headers?.get?.('Retry-After'));
            await new Promise(resolve => window.setTimeout(
              resolve,
              Number.isFinite(retrySeconds) ? Math.max(500, retrySeconds * 1000) : 2000,
            ));
            continue;
          }
          if (!response.ok) throw new Error(`Workspace discovery failed (${response.status})`);
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
          transientFailures += 1;
          if (transientFailures >= 4) break;
          await new Promise(resolve => window.setTimeout(resolve, 250 * transientFailures));
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
  if (status === 'migrating') {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <div className="app-loading__content">
          <div className="app-loading__mark" aria-hidden="true"><span>F</span></div>
          <span>Verifying and migrating workspace data. Your files are safe; the first upgrade can take a while.</span>
        </div>
      </div>
    );
  }
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
