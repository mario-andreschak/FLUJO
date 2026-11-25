"use client";

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  getSelectedWorkspace,
  initializeWorkspaceSelection,
  readWorkspacePageRequest,
  setSelectedWorkspace,
  workspacePageUrl,
} from '@/frontend/utils/workspaceSelection';
import { migrateLegacyBrowserWorkspaceContent } from '@/frontend/utils/workspaceContentKeys';
import { discoverWorkspaces, fallbackWorkspace } from '@/frontend/utils/workspaceDiscovery';

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
  const [status, setStatus] = useState<
    'loading' | 'slow' | 'migrating' | 'ready' | 'error' | 'owner-auth' | 'account-sign-in' | 'no-workspace'
  >('loading');
  const [errorMessage, setErrorMessage] = useState('FLUJO did not answer for a minute. Check that it is still running, then retry.');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const outcome = await discoverWorkspaces({
        isCancelled: () => cancelled,
        onMigrating: () => { if (!cancelled) setStatus('migrating'); },
        onSlow: () => { if (!cancelled) setStatus('slow'); },
      });
      if (cancelled || outcome.kind === 'cancelled') return;
      if (outcome.kind === 'owner-auth' || outcome.kind === 'account-sign-in') {
        setStatus(outcome.kind);
        return;
      }
      if (outcome.kind === 'accounts-damaged') {
        setErrorMessage(outcome.message);
        setStatus('error');
        return;
      }
      // Data providers stay unmounted until discovery succeeds, so they never
      // fall back to a guessed workspace or fire a storm of 404s.
      if (outcome.kind === 'unavailable') {
        setStatus('error');
        return;
      }

      const pageRequest = pageRequestOnMount.current;
      if (pageRequest.kind === 'invalid') {
        setErrorMessage('The workspace in this link is invalid.');
        setStatus('error');
        return;
      }

      const requested = pageRequest.kind === 'valid' ? pageRequest.workspace : getSelectedWorkspace();
      if (!outcome.names.has(requested)) {
        if (pageRequest.kind === 'valid') {
          setErrorMessage(`Unknown workspace: ${requested}`);
          setStatus('error');
          return;
        }
        // In multi-user mode a person may lack the default workspace, or have none.
        const nextWorkspace = fallbackWorkspace(outcome.names);
        if (!nextWorkspace) {
          setStatus('no-workspace');
          return;
        }
        setSelectedWorkspace(nextWorkspace);
        window.location.assign(workspacePageUrl(nextWorkspace));
        return;
      }

      // initializeWorkspaceSelection froze a valid top-level deep link as
      // this tab's request workspace before providers mounted. Discovery
      // has now confirmed it exists, so persist it as the next-load/default
      // preference. No reload is needed (or safe when storage is blocked).
      if (pageRequest.kind === 'valid') {
        setSelectedWorkspace(requested);
      }
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'ready') return <>{children}</>;
  if (status === 'slow') {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <div className="app-loading__content">
          <div className="app-loading__mark" aria-hidden="true"><span>F</span></div>
          <span>FLUJO is taking longer than usual to answer. Still trying…</span>
        </div>
      </div>
    );
  }
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
  if (status === 'owner-auth' || status === 'account-sign-in') {
    const returnTo = window.location.pathname + window.location.search + window.location.hash;
    const owner = status === 'owner-auth';
    return <div className="app-loading" role="alert">
      <div className="app-loading__content">
        <span>{owner ? 'Sign in as the owner to open this workspace.' : 'Sign in to open FLUJO.'}</span>
        <Link href={`/owner/login?returnTo=${encodeURIComponent(returnTo)}`}>{owner ? 'Owner sign in' : 'Sign in'}</Link>
      </div>
    </div>;
  }
  if (status === 'no-workspace') {
    return <div className="app-loading" role="alert">
      <div className="app-loading__content">
        <span>You do not have a workspace yet. Ask an admin to give you one.</span>
        <Link href="/owner/login">Sign in as someone else</Link>
      </div>
    </div>;
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
