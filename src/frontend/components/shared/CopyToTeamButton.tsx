'use client';

import { useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  type SxProps,
  type Theme,
} from '@mui/material';
import GroupAddOutlinedIcon from '@mui/icons-material/GroupAddOutlined';
import { isMultiUserMode, type SharedItemKind } from '@/frontend/services/sharedItems';
import { copyToWorkspace, listCopyTargets, type CopyDependency, type CopyResult, type CopyTarget } from '@/frontend/services/teamCopy';

/**
 * "Copy to a team workspace" (#575). Shows nothing unless sign-in for several
 * people is on. The dialog lets the person pick a workspace they may change,
 * says plainly that keys and passwords stay behind, and afterwards lists what
 * to enter in the team workspace and which other items the copy still needs.
 */

const KIND_WORDS: Readonly<Record<SharedItemKind, string>> = {
  flow: 'flow',
  model: 'model',
  'mcp-server': 'MCP server',
};

type Step =
  | { kind: 'loading' }
  | { kind: 'choose'; targets: CopyTarget[] }
  | { kind: 'copying'; targets: CopyTarget[] }
  | { kind: 'done'; result: CopyResult }
  | { kind: 'failed'; message: string; dependencies: readonly CopyDependency[]; targets: CopyTarget[] };

function targetLabel(target: CopyTarget): string {
  if (target.ownerType === 'team') return target.teamName ? `Team ${target.teamName}: ${target.workspace}` : `Team workspace: ${target.workspace}`;
  if (target.mine) return `Your workspace: ${target.workspace}`;
  return `Workspace: ${target.workspace}`;
}

function DependencyList({ items }: { items: readonly CopyDependency[] }) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 3 }}>
      {items.map(item => (
        <li key={`${item.kind}:${item.id}`}>
          <Typography variant="body2">{item.name} ({KIND_WORDS[item.kind]})</Typography>
        </li>
      ))}
    </Box>
  );
}

export interface CopyToTeamButtonProps {
  readonly kind: SharedItemKind;
  readonly itemId: string;
  readonly itemName: string;
  readonly size?: 'small' | 'medium';
  readonly sx?: SxProps<Theme>;
}

export default function CopyToTeamButton({ kind, itemId, itemName, size = 'small', sx }: CopyToTeamButtonProps) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [target, setTarget] = useState('');
  const active = useRef<AbortController | null>(null);

  useEffect(() => {
    let mounted = true;
    void isMultiUserMode().then(on => { if (mounted) setEnabled(on); });
    return () => {
      mounted = false;
      active.current?.abort();
    };
  }, []);

  if (!enabled) return null;

  const words = KIND_WORDS[kind];
  const title = 'Copy to a team workspace';

  const load = () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setStep({ kind: 'loading' });
    listCopyTargets(controller.signal)
      .then(targets => {
        if (controller.signal.aborted) return;
        const list = targets ?? [];
        setTarget(current => list.some(item => item.workspace === current) ? current : list[0]?.workspace ?? '');
        setStep({ kind: 'choose', targets: list });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStep({ kind: 'failed', message: error instanceof Error ? error.message : 'Something went wrong. Try again.', dependencies: [], targets: [] });
      });
  };

  const openDialog = (event: MouseEvent) => {
    event.stopPropagation();
    setOpen(true);
    load();
  };

  const close = () => {
    active.current?.abort();
    setOpen(false);
  };

  const copy = async (targets: CopyTarget[]) => {
    if (!target) return;
    setStep({ kind: 'copying', targets });
    const answer = await copyToWorkspace(kind, itemId, target);
    if (answer.ok) setStep({ kind: 'done', result: answer.result });
    else setStep({ kind: 'failed', message: answer.error, dependencies: answer.missingDependencies, targets });
  };

  // Clicks inside the dialog travel up the React tree to the card; keep them here.
  const stop = (event: SyntheticEvent) => event.stopPropagation();
  const targets = step.kind === 'choose' || step.kind === 'copying' || step.kind === 'failed' ? step.targets : [];

  return (
    <Box component="span" onClick={stop} onMouseDown={stop} onKeyDown={stop} sx={{ display: 'inline-flex' }}>
      <Tooltip title={title}>
        <IconButton size={size} aria-label={`${title}: ${itemName}`} onClick={openDialog} sx={sx}>
          <GroupAddOutlinedIcon fontSize={size === 'small' ? 'small' : 'medium'} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={close} fullWidth maxWidth="sm" aria-labelledby={`copy-to-team-${kind}-${itemId}`}>
        <DialogTitle id={`copy-to-team-${kind}-${itemId}`}>Copy “{itemName}” to another workspace</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {step.kind === 'loading' && <Typography role="status">Loading the workspaces you can change…</Typography>}

            {(step.kind === 'choose' || step.kind === 'copying' || step.kind === 'failed') && targets.length > 0 && (
              <>
                <Alert severity="info">
                  Keys, passwords and sign-ins are not copied. After copying, enter the team&apos;s own values in the
                  team workspace. Your own keys stay in your workspace.
                </Alert>
                <TextField select label="Copy into" value={target} disabled={step.kind === 'copying'}
                  slotProps={{ select: { native: true } }} onChange={event => setTarget(event.target.value)}>
                  {targets.map(item => <option key={item.workspace} value={item.workspace}>{targetLabel(item)}</option>)}
                </TextField>
              </>
            )}

            {step.kind === 'choose' && targets.length === 0 && (
              <Alert severity="info">
                There is no other workspace you can change. Ask an admin or a team owner to add you to a team as a member.
              </Alert>
            )}

            {step.kind === 'failed' && (
              <Alert severity="error" role="alert">
                <Stack spacing={1}>
                  <span>{step.message}</span>
                  {step.dependencies.length > 0 && <DependencyList items={step.dependencies} />}
                </Stack>
              </Alert>
            )}

            {step.kind === 'done' && (
              <>
                <Alert severity="success" role="status">
                  Copied the {words} as “{step.result.copied.name}” into {step.result.targetWorkspace}.
                  {kind === 'mcp-server' && ' It is turned off there until someone turns it on.'}
                </Alert>
                {step.result.missingValues.length > 0 && (
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" component="h3">Enter these in the team workspace</Typography>
                    <Box component="ul" sx={{ m: 0, pl: 3 }}>
                      {step.result.missingValues.map(item => (
                        <li key={item.field}>
                          <Typography variant="body2"><strong>{item.field}</strong>: {item.hint}</Typography>
                        </li>
                      ))}
                    </Box>
                  </Stack>
                )}
                {step.result.missingDependencies.length > 0 && (
                  <Stack spacing={1}>
                    <Typography variant="subtitle2" component="h3">
                      This {words} uses these, which the team workspace does not have yet. Copy them too:
                    </Typography>
                    <DependencyList items={step.result.missingDependencies} />
                  </Stack>
                )}
                {step.result.missingValues.length === 0 && step.result.missingDependencies.length === 0 && (
                  <Typography variant="body2">Nothing else is needed. It is ready to use there.</Typography>
                )}
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {step.kind === 'done'
            ? <Button onClick={close} variant="contained">Done</Button>
            : (
              <>
                <Button onClick={close} disabled={step.kind === 'copying'}>Cancel</Button>
                {step.kind === 'failed' && targets.length === 0
                  ? <Button onClick={load}>Try again</Button>
                  : (
                    <Button variant="contained" disabled={(step.kind !== 'choose' && step.kind !== 'failed') || !target}
                      onClick={() => void copy(targets)}>
                      {step.kind === 'copying' ? 'Copying…' : 'Copy'}
                    </Button>
                  )}
              </>
            )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
