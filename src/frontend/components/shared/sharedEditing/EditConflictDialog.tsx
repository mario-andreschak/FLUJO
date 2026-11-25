"use client";

import React, { useMemo, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Typography,
} from '@mui/material';
import { describeDifferences, type EditConflict } from '@/frontend/services/sharedItems';

export interface EditConflictDialogProps {
  /** The refused save; `null` keeps the dialog closed. */
  readonly conflict: EditConflict | null;
  /** What this person tried to save. */
  readonly mine: unknown;
  readonly busy?: boolean;
  /** Throw away my changes and show the newer version. */
  readonly onLoadTheirs: () => void;
  /** Save my version over theirs on purpose (theirs stays in the change history). */
  readonly onSaveMine: () => void;
  /** Close without choosing; my changes stay in the editor, unsaved. */
  readonly onClose: () => void;
}

function when(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return '';
  }
}

/**
 * "Someone else saved first" (#575). Explains in plain words what happened
 * and lets the person load the newer version, compare, or save theirs anyway.
 * Nothing is lost either way: the version that gets replaced stays in the
 * change history.
 */
export default function EditConflictDialog({ conflict, mine, busy = false, onLoadTheirs, onSaveMine, onClose }: EditConflictDialogProps) {
  const [comparing, setComparing] = useState(false);
  const differences = useMemo(
    () => (conflict && comparing ? describeDifferences(mine, conflict.current) : []),
    [comparing, conflict, mine],
  );
  const who = conflict?.changedBy?.name ?? 'Someone else';
  const at = conflict?.changedBy ? when(conflict.changedBy.at) : '';

  const close = () => {
    setComparing(false);
    onClose();
  };

  return (
    <Dialog open={conflict !== null} onClose={busy ? undefined : close} maxWidth="md" fullWidth
      aria-labelledby="edit-conflict-title">
      <DialogTitle id="edit-conflict-title">Someone else saved first</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <Typography>
            {who} saved this{at ? ` at ${at}` : ''} while you were editing it. Your changes are not saved yet.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Choose what to keep. If you save yours, their version is not lost: it stays in the change history.
          </Typography>
          {comparing && (
            differences.length === 0
              ? <Alert severity="info">Your version and theirs look the same.</Alert>
              : (
                <TableContainer>
                  <Table size="small" aria-label="Differences between your version and theirs">
                    <TableHead>
                      <TableRow>
                        <TableCell>Setting</TableCell>
                        <TableCell>Yours</TableCell>
                        <TableCell>Theirs</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {differences.map(difference => (
                        <TableRow key={difference.field}>
                          <TableCell sx={{ fontWeight: 600 }}>{difference.field}</TableCell>
                          <TableCell sx={{ wordBreak: 'break-word' }}>{difference.mine}</TableCell>
                          <TableCell sx={{ wordBreak: 'break-word' }}>{difference.theirs}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Button disabled={busy} onClick={close}>Keep editing</Button>
        </Box>
        <Button disabled={busy} onClick={() => setComparing(value => !value)}>
          {comparing ? 'Hide comparison' : 'Compare'}
        </Button>
        <Button disabled={busy} variant="outlined" onClick={() => { setComparing(false); onLoadTheirs(); }}>
          Load their version
        </Button>
        <Button disabled={busy} variant="contained" color="warning" onClick={() => { setComparing(false); onSaveMine(); }}>
          Save mine anyway
        </Button>
      </DialogActions>
    </Dialog>
  );
}
