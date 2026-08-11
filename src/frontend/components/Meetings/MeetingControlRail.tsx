"use client";

import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { HowToVoteRounded, LockRounded, SendRounded, TuneRounded } from '@mui/icons-material';
import type { MeetingMotion, MeetingMotionKind, MeetingRecord } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import PromptTemplateEditor from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptTemplateEditor';

interface MeetingControlRailProps {
  meeting: MeetingRecord;
  onPrivateNote: (content: string) => Promise<void>;
  onSteer: (content: string) => Promise<void>;
  onProposeMotion: (motion: MeetingMotion) => void;
}

export default function MeetingControlRail({ meeting, onPrivateNote, onSteer, onProposeMotion }: MeetingControlRailProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const [message, setMessage] = useState('');
  const [motionOpen, setMotionOpen] = useState(false);
  const [motionKind, setMotionKind] = useState<MeetingMotionKind>('followup');
  const [proposal, setProposal] = useState('');
  const [rationale, setRationale] = useState('');
  const [busyAction, setBusyAction] = useState<'note' | 'steer' | null>(null);
  const [feedback, setFeedback] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);
  const live = meeting.status === 'running';
  const terminal = ['completed', 'cancelled', 'error'].includes(meeting.status);
  const steerLabel = t(terminal ? 'meetings.control.continueWithPrompt' : 'meetings.control.steerPrompt');

  const submit = async (kind: 'note' | 'steer') => {
    const content = message.trim();
    if (!content) return;
    setBusyAction(kind);
    setFeedback(null);
    try {
      if (kind === 'note') await onPrivateNote(content);
      else await onSteer(content);
      setMessage('');
      setFeedback({
        severity: 'success',
        message: t(kind === 'note'
          ? 'meetings.control.noteSaved'
          : terminal
            ? 'meetings.control.continuedWithPrompt'
            : 'meetings.control.steerQueued'),
      });
    } catch (error) {
      setFeedback({ severity: 'error', message: error instanceof Error ? error.message : t('meetings.control.failed') });
    } finally {
      setBusyAction(null);
    }
  };

  const openMotion = () => {
    setProposal(message.trim());
    setMotionOpen(true);
  };

  const createMotion = () => {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `human-motion-${Date.now()}`;
    onProposeMotion({
      id,
      kind: motionKind,
      proposal: proposal.trim(),
      reason: rationale.trim() || undefined,
      proposedByParticipantId: 'human',
      roundId: meeting.activeRound?.id ?? 'human-intervention',
      status: 'open',
      votes: [],
      createdAt: Date.now(),
    });
    setMessage('');
    setProposal('');
    setRationale('');
    setMotionOpen(false);
    setFeedback({ severity: 'success', message: t('meetings.control.motionAdded') });
  };

  return (
    <>
      <Paper
        variant="outlined"
        sx={{
          mb: 2,
          p: 1.25,
          borderColor: alpha(theme.palette.primary.main, 0.24),
          bgcolor: alpha(theme.palette.primary.main, 0.025),
        }}
      >
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            maxRows={5}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            label={terminal ? steerLabel : t('meetings.control.composer')}
            placeholder={t(terminal ? 'meetings.control.continuePlaceholder' : 'meetings.control.placeholder')}
            inputProps={{ maxLength: 12_000 }}
          />
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            <Tooltip title={t('meetings.control.privateNote')}>
              <span>
                <IconButton color="secondary" disabled={!message.trim() || Boolean(busyAction)} onClick={() => void submit('note')} aria-label={t('meetings.control.privateNote')}>
                  {busyAction === 'note' ? <CircularProgress size={21} /> : <LockRounded />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t('meetings.control.proposeMotion')}>
              <span>
                <IconButton color="secondary" disabled={!live || Boolean(busyAction)} onClick={openMotion} aria-label={t('meetings.control.proposeMotion')}>
                  <HowToVoteRounded />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={steerLabel}>
              <span>
                <IconButton color="primary" disabled={(!live && !terminal) || !message.trim() || Boolean(busyAction)} onClick={() => void submit('steer')} aria-label={steerLabel}>
                  {busyAction === 'steer' ? <CircularProgress size={21} /> : <TuneRounded />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1.3} sx={{ mt: 0.7, px: 0.5 }}>
          <Typography variant="caption" color="text.secondary"><LockRounded sx={{ fontSize: 12, verticalAlign: -2, mr: 0.3 }} />{t('meetings.control.privateNote')}</Typography>
          <Typography variant="caption" color="text.secondary"><HowToVoteRounded sx={{ fontSize: 12, verticalAlign: -2, mr: 0.3 }} />{t('meetings.control.proposeMotion')}</Typography>
          <Typography variant="caption" color="text.secondary"><TuneRounded sx={{ fontSize: 12, verticalAlign: -2, mr: 0.3 }} />{steerLabel}</Typography>
        </Stack>
        {feedback && <Alert severity={feedback.severity} onClose={() => setFeedback(null)} sx={{ mt: 1 }}>{feedback.message}</Alert>}
      </Paper>

      <Dialog open={motionOpen} onClose={() => setMotionOpen(false)} fullWidth maxWidth="sm">
        <DialogHeaderActions title={t('meetings.control.motionTitle')} onClose={() => setMotionOpen(false)} showAskFlujo={false} showBugReport={false} />
        <DialogContent dividers>
          <Stack spacing={2}>
            <FormControl fullWidth>
              <InputLabel>{t('meetings.control.motionKind')}</InputLabel>
              <Select value={motionKind} label={t('meetings.control.motionKind')} onChange={(event) => setMotionKind(event.target.value as MeetingMotionKind)}>
                <MenuItem value="followup">{t('meetings.control.motionFollowup')}</MenuItem>
                <MenuItem value="finish">{t('meetings.control.motionFinish')}</MenuItem>
                <MenuItem value="cancel">{t('meetings.control.motionCancel')}</MenuItem>
              </Select>
            </FormControl>
            <TextField
              autoFocus
              fullWidth
              label={t('meetings.control.proposal')}
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
              inputProps={{ maxLength: 500 }}
            />
            <Box sx={{ height: 210 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.7 }}>{t('meetings.control.rationale')}</Typography>
              <PromptTemplateEditor
                promptTemplate={rationale}
                handlePromptChange={setRationale}
                excludeModelPrompt={false}
                excludeStartNodePrompt={false}
                excludeSystemPrompt={false}
                nodeData={{ id: 'meeting-motion-rationale' }}
                renderPromptPreview={false}
              />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMotionOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" startIcon={<SendRounded />} disabled={proposal.trim().length < 3} onClick={createMotion}>{t('meetings.control.propose')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
