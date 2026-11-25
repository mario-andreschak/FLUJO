"use client";

import React, { useEffect, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';
import {
  EDIT_CONFLICT_EVENT, type EditConflictEventDetail, type SharedItemKind,
} from '@/frontend/services/sharedItems';
import EditConflictDialog from './EditConflictDialog';

/**
 * Shows "Someone else saved first" for saves whose result does not travel
 * back to the editor (the MCP server editor closes as soon as it saves). The
 * save service announces the refused save as a window event; this host, kept
 * on the page, answers it. Only ever appears while multi-user mode is on,
 * because only then does the server refuse a save this way.
 */
export default function EditConflictHost({ kind, onReload }: {
  readonly kind: SharedItemKind;
  /** Load the newest versions from the server again. */
  readonly onReload: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState<EditConflictEventDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<EditConflictEventDetail>).detail;
      if (detail?.conflict?.kind === kind) setPending(detail);
    };
    window.addEventListener(EDIT_CONFLICT_EVENT, listener);
    return () => window.removeEventListener(EDIT_CONFLICT_EVENT, listener);
  }, [kind]);

  const loadTheirs = async () => {
    setPending(null);
    await onReload();
  };

  const saveMine = async () => {
    if (!pending) return;
    setBusy(true);
    const saved = await pending.saveMine().catch(() => false);
    setBusy(false);
    setPending(null);
    setMessage(saved ? 'Your version is saved. Theirs is kept in the change history.' : 'Your version could not be saved. Try again.');
    await onReload();
  };

  return (
    <>
      <EditConflictDialog
        conflict={pending?.conflict ?? null}
        mine={pending?.mine ?? null}
        busy={busy}
        onLoadTheirs={() => void loadTheirs()}
        onSaveMine={() => void saveMine()}
        onClose={() => { setPending(null); void onReload(); }}
      />
      <Snackbar open={message !== null} autoHideDuration={6000} onClose={() => setMessage(null)}>
        <Alert severity="info" onClose={() => setMessage(null)}>{message}</Alert>
      </Snackbar>
    </>
  );
}
