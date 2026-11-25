"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Stack,
  Typography,
} from '@mui/material';
import {
  getEditBase, loadHistory, loadHistoryEntry, restoreHistoryEntry,
  type HistoryAction, type HistoryEntry, type HistorySummary, type SharedItemKind,
} from '@/frontend/services/sharedItems';

const ACTION_WORDS: Readonly<Record<HistoryAction, string>> = {
  created: 'Created it',
  saved: 'Saved a change',
  restored: 'Brought back an older version',
  deleted: 'Deleted it',
  'copied-in': 'Copied it in from another workspace',
};

export interface ChangeHistoryDialogProps {
  readonly open: boolean;
  readonly kind: SharedItemKind;
  readonly itemId: string | null | undefined;
  /** "flow", "model", "MCP server": used in the plain text. */
  readonly itemLabel: string;
  readonly onClose: () => void;
  /** Called with the item as stored after a restore, so the page can show it. */
  readonly onRestored?: (item: unknown) => void;
  /** The version the open editor started from, if the page knows it better than the registry. */
  readonly baseRevision?: () => string | null;
}

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'ready'; readonly entries: readonly HistorySummary[] };

function when(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return '';
  }
}

/**
 * Who changed this, when, and what it looked like (#575). Only reachable
 * while multi-user mode is on. Restoring an older version saves it as the
 * newest one; the version it replaces stays in the list, so a restore can be
 * undone the same way. Stored keys never appear here and a restore never
 * changes them.
 */
export default function ChangeHistoryDialog({ open, kind, itemId, itemLabel, onClose, onRestored, baseRevision }: ChangeHistoryDialogProps) {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [viewing, setViewing] = useState<HistoryEntry | null>(null);
  const [notice, setNotice] = useState<{ severity: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!open || !itemId) return undefined;
    let cancelled = false;
    void loadHistory(kind, itemId)
      .then(result => {
        if (cancelled) return;
        if (result.error) setListing({ state: 'failed', message: result.error });
        else setListing({ state: 'ready', entries: result.entries });
      })
      .catch(() => {
        if (!cancelled) setListing({ state: 'failed', message: 'Could not reach FLUJO. Try again.' });
      });
    return () => { cancelled = true; };
  }, [open, kind, itemId, reloadKey]);

  const close = () => {
    setViewing(null);
    setNotice(null);
    setListing({ state: 'loading' });
    onClose();
  };

  const view = useCallback(async (entry: HistorySummary) => {
    if (!itemId) return;
    setBusy(true);
    setNotice(null);
    const result = await loadHistoryEntry(kind, itemId, entry.entryId);
    if (!mounted.current) return;
    setBusy(false);
    if (result.entry) setViewing(result.entry);
    else setNotice({ severity: 'error', text: result.error ?? 'Could not read that version.' });
  }, [itemId, kind]);

  const restore = useCallback(async (entry: HistorySummary) => {
    if (!itemId) return;
    setBusy(true);
    setNotice(null);
    const result = await restoreHistoryEntry(kind, itemId, entry.entryId, baseRevision?.() ?? getEditBase(kind, itemId));
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setNotice({ severity: 'error', text: result.error });
      return;
    }
    setViewing(null);
    setNotice({ severity: 'success', text: `The version from ${when(entry.at)} is the newest version again.` });
    setReloadKey(value => value + 1);
    onRestored?.(result.item);
  }, [baseRevision, itemId, kind, onRestored]);

  const restorable = (entry: HistorySummary) => entry.action !== 'deleted';

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="md" fullWidth aria-labelledby="change-history-title">
      <DialogTitle id="change-history-title">Who changed this {itemLabel}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Every change in this team workspace is listed with who made it. Bringing back an older version saves it as
            the newest one; stored keys are never shown here and never changed by it.
          </Typography>
          {notice && <Alert severity={notice.severity} role={notice.severity === 'error' ? 'alert' : 'status'}>{notice.text}</Alert>}
          {listing.state === 'loading' && <Typography role="status">Loading…</Typography>}
          {listing.state === 'failed' && <Alert severity="error">{listing.message}</Alert>}
          {listing.state === 'ready' && listing.entries.length === 0 && (
            <Typography>No changes are recorded yet. Changes are recorded from now on.</Typography>
          )}
          {listing.state === 'ready' && listing.entries.length > 0 && (
            <List dense aria-label="Changes, newest first">
              {listing.entries.map((entry, index) => (
                <ListItem key={entry.entryId} divider
                  secondaryAction={(
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Button size="small" disabled={busy} onClick={() => void view(entry)}>View</Button>
                      {index > 0 && restorable(entry) && (
                        <Button size="small" variant="outlined" disabled={busy} onClick={() => void restore(entry)}>
                          Restore this version
                        </Button>
                      )}
                    </Box>
                  )}>
                  <ListItemText
                    primary={`${ACTION_WORDS[entry.action] ?? entry.action}${index === 0 ? ' (newest)' : ''}`}
                    secondary={`${entry.actor.name}, ${when(entry.at)}`}
                    sx={{ pr: 24 }}
                  />
                </ListItem>
              ))}
            </List>
          )}
          {viewing && (
            <Box>
              <Typography variant="subtitle2" component="h3">
                What it looked like after {viewing.actor.name}&apos;s change on {when(viewing.at)}
              </Typography>
              <Box component="pre" sx={{ maxHeight: 320, overflow: 'auto', p: 1, bgcolor: 'action.hover', fontSize: 12 }}>
                {JSON.stringify(viewing.snapshot, null, 2)}
              </Box>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
