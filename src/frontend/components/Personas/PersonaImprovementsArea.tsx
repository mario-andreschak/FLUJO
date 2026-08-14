"use client";

import {
  AutoAwesomeRounded,
  CheckRounded,
  CloseRounded,
  ShareRounded,
  UndoRounded,
  VerifiedRounded,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { personasService, type PersonaDetail } from '@/frontend/services/personas';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { BehaviorProposal, BehaviorProposalStatus } from '@/shared/types/enduringAgent';

const STATUS_COLOR: Record<BehaviorProposalStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  validation_failed: 'warning',
  awaiting_approval: 'info',
  approved: 'info',
  rejected: 'default',
  activated: 'success',
  rolled_back: 'default',
};

function sourceLabel(kind: string, t: ReturnType<typeof useI18n>['t']): string {
  if (kind === 'user_statement') return t('personas.improvements.source.you');
  if (kind === 'tool_result') return t('personas.improvements.source.app');
  if (kind === 'activity') return t('personas.improvements.source.work');
  return t('personas.improvements.source.evidence');
}

export default function PersonaImprovementsArea({ detail }: { detail: PersonaDetail }) {
  const { t, formatDate } = useI18n();
  const [proposals, setProposals] = useState<BehaviorProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<BehaviorProposal | null>(null);
  const [migrationNotes, setMigrationNotes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProposals(await personasService.improvements(detail.persona.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.improvements.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [detail.persona.id, t]);

  useEffect(() => { void load(); }, [load]);

  const replace = (updated: BehaviorProposal) => {
    setProposals((current) => current.map((proposal) => (
      proposal.id === updated.id ? updated : proposal
    )));
  };

  const act = async (
    proposal: BehaviorProposal,
    action: () => Promise<BehaviorProposal>,
    success: string,
  ) => {
    setActing(proposal.id);
    setError(null);
    setNotice(null);
    try {
      replace(await action());
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      setActing(null);
    }
  };

  const promote = async () => {
    if (!promotion || !migrationNotes.trim() || acting !== null) return;
    setActing(promotion.id);
    setError(null);
    setNotice(null);
    try {
      const result = await personasService.promoteImprovement(
        detail.persona.id,
        promotion.id,
        {
          confirmation: 'PROMOTE',
          migrationNotes: migrationNotes.trim(),
        },
      );
      replace(result.proposal);
      setPromotion(null);
      setMigrationNotes('');
      setNotice(t('personas.improvements.sharedNotice'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      setActing(null);
    }
  };

  const visible = useMemo(() => [...proposals].sort((left, right) => (
    Number(['rejected', 'rolled_back'].includes(left.status))
      - Number(['rejected', 'rolled_back'].includes(right.status))
    || right.updatedAt - left.updatedAt
  )), [proposals]);

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
      <Stack spacing={2.5}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <AutoAwesomeRounded color="primary" />
              <Typography variant="h5" fontWeight={760}>{t('personas.improvements.title')}</Typography>
            </Stack>
            <Typography color="text.secondary" sx={{ mt: 0.5 }}>
              {t('personas.improvements.description')}
            </Typography>
          </Box>
          <Button onClick={() => void load()} disabled={loading || acting !== null}>
            {t('personas.refresh')}
          </Button>
        </Stack>

        <Alert severity="info" icon={<VerifiedRounded />}>
          {t('personas.improvements.safety')}
        </Alert>
        {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
        {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}
        {loading ? (
          <Stack alignItems="center" py={5}><CircularProgress /></Stack>
        ) : visible.length === 0 ? (
          <Box sx={{ py: 5, textAlign: 'center' }}>
            <AutoAwesomeRounded sx={{ fontSize: 42, color: 'text.disabled', mb: 1 }} />
            <Typography variant="h6" fontWeight={720}>{t('personas.improvements.empty')}</Typography>
            <Typography color="text.secondary">{t('personas.improvements.emptyHelp')}</Typography>
          </Box>
        ) : (
          <Stack spacing={1.5}>
            {visible.map((proposal) => {
              const behavior = detail.persona.composition?.behaviors?.find((candidate) => (
                candidate.ref === proposal.behaviorId || candidate.slotKey === proposal.slotKey
              ));
              const checked = proposal.evalResults.length > 0
                && proposal.evalResults.every((result) => result.passed)
                && proposal.validation.errorCount === 0;
              return (
                <Card key={proposal.id} variant="outlined" sx={{ borderRadius: 3 }}>
                  <CardContent>
                    <Stack spacing={1.5}>
                      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
                        <Box>
                          <Typography variant="h6" fontWeight={740}>
                            {behavior?.name ?? t('personas.improvements.behaviorFallback')}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t('personas.improvements.updated', {
                              date: formatDate(proposal.updatedAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              }),
                            })}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                           <Chip
                            size="small"
                            color={STATUS_COLOR[proposal.status]}
                            label={t(`personas.improvements.status.${proposal.status}`)}
                          />
                          <Chip
                            size="small"
                            variant="outlined"
                            color={checked ? 'success' : 'warning'}
                            icon={checked ? <VerifiedRounded /> : undefined}
                            label={checked
                              ? t('personas.improvements.checksPassed', { count: proposal.evalResults.length })
                             : t('personas.improvements.needsWork')}
                           />
                           {proposal.promotedRoleVersionId && (
                             <Chip
                               size="small"
                               color="success"
                               variant="outlined"
                               icon={<ShareRounded />}
                               label={t('personas.improvements.shared')}
                             />
                           )}
                         </Stack>
                       </Stack>
                       <Typography>{proposal.rationale}</Typography>
                       {proposal.changeSummary && (
                         <Box>
                           <Typography variant="subtitle2">
                             {t('personas.improvements.whatChanges')}
                           </Typography>
                           <Typography>{proposal.changeSummary}</Typography>
                         </Box>
                       )}
                       <Divider />
                      <Box>
                        <Typography variant="subtitle2">{t('personas.improvements.basedOn')}</Typography>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                          {[...new Set(proposal.evidenceRefs.map((source) => source.kind))].map((kind) => (
                            <Chip key={kind} size="small" variant="outlined" label={sourceLabel(kind, t)} />
                          ))}
                        </Stack>
                      </Box>
                       {proposal.validation.issues.length > 0 && (
                        <Alert severity="warning">
                          {proposal.validation.issues.map((issue) => issue.message).join(' ')}
                         </Alert>
                       )}
                       {proposal.promotedRoleVersionId && (
                         <Alert
                           severity="success"
                           action={(
                             <Button
                               component={Link}
                               href={withWorkspaceUrl(
                                 `/roles/${encodeURIComponent(detail.roleVersion.roleDefinitionId)}`,
                               )}
                               size="small"
                             >
                               {t('personas.improvements.openRoleHistory')}
                             </Button>
                           )}
                         >
                           {t('personas.improvements.sharedExplanation', {
                             role: detail.roleVersion.name,
                           })}
                         </Alert>
                       )}
                    </Stack>
                  </CardContent>
                  <CardActions sx={{ px: 2, pb: 2, flexWrap: 'wrap' }}>
                    {(proposal.status === 'awaiting_approval' || proposal.status === 'approved') && (
                      <Button
                        variant="contained"
                        startIcon={<CheckRounded />}
                        disabled={acting !== null}
                        onClick={() => void act(
                          proposal,
                          () => personasService.applyImprovement(detail.persona.id, proposal.id),
                          t('personas.improvements.applied'),
                        )}
                      >
                        {t('personas.improvements.apply')}
                      </Button>
                    )}
                    {['validation_failed', 'awaiting_approval', 'approved'].includes(proposal.status) && (
                      <Button
                        startIcon={<CloseRounded />}
                        disabled={acting !== null}
                        onClick={() => void act(
                          proposal,
                          () => personasService.rejectImprovement(detail.persona.id, proposal.id),
                          t('personas.improvements.rejected'),
                        )}
                      >
                        {t('personas.improvements.reject')}
                      </Button>
                    )}
                     {proposal.status === 'activated' && (
                      <Button
                        color="warning"
                        startIcon={<UndoRounded />}
                        disabled={acting !== null}
                        onClick={() => void act(
                          proposal,
                          () => personasService.undoImprovement(detail.persona.id, proposal.id),
                          t('personas.improvements.undone'),
                        )}
                      >
                        {t('personas.improvements.undo')}
                       </Button>
                     )}
                     {proposal.status === 'activated' && !proposal.promotedRoleVersionId && (
                       <Button
                         startIcon={<ShareRounded />}
                         disabled={acting !== null}
                         onClick={() => {
                           setMigrationNotes('');
                           setPromotion(proposal);
                         }}
                       >
                         {t('personas.improvements.shareWithRole')}
                       </Button>
                     )}
                   </CardActions>
                </Card>
              );
            })}
          </Stack>
         )}
       </Stack>
       <Dialog
         open={promotion !== null}
         onClose={() => {
           if (acting === null) setPromotion(null);
         }}
         fullWidth
         maxWidth="sm"
       >
         <DialogTitle>{t('personas.improvements.shareTitle')}</DialogTitle>
         <DialogContent dividers>
           <Stack spacing={2}>
             <Alert severity="info">
               {t('personas.improvements.shareExplanation', {
                 role: detail.roleVersion.name,
               })}
             </Alert>
             <TextField
               autoFocus
               required
               fullWidth
               multiline
               minRows={3}
               label={t('personas.improvements.migrationNotes')}
               helperText={t('personas.improvements.migrationNotesHelp')}
               value={migrationNotes}
               onChange={(event) => setMigrationNotes(event.target.value)}
               inputProps={{ maxLength: 10_000 }}
             />
           </Stack>
         </DialogContent>
         <DialogActions>
           <Button disabled={acting !== null} onClick={() => setPromotion(null)}>
             {t('personas.action.cancel')}
           </Button>
           <Button
             variant="contained"
             disabled={acting !== null || !migrationNotes.trim()}
             onClick={() => void promote()}
           >
             {t('personas.improvements.confirmShare')}
           </Button>
         </DialogActions>
       </Dialog>
     </Paper>
  );
}
