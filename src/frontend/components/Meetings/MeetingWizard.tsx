"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  IconButton,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  Slider,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  AddRounded,
  AttachFileRounded,
  AutoAwesomeRounded,
  CheckCircleRounded,
  CloseRounded,
  DescriptionRounded,
  GroupsRounded,
  HowToVoteRounded,
  PersonRounded,
  RemoveCircleOutlineRounded,
  ShieldRounded,
} from '@mui/icons-material';
import type { Flow } from '@/shared/types/flow';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type {
  CreateMeetingInput,
  MeetingModeratorMode,
  MeetingPolicy,
} from '@/shared/types/meeting';
import { flowService } from '@/frontend/services/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

interface MeetingWizardProps {
  open: boolean;
  submitting?: boolean;
  error?: string | null;
  initialInput?: CreateMeetingInput | null;
  onClose: () => void;
  onSubmit: (input: CreateMeetingInput) => void | Promise<void>;
}

interface DraftParticipant {
  id: string;
  flowId?: string;
  personaId?: string;
  behaviorSlotKey?: string;
  flowName: string;
  name: string;
}

const makeId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `participant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const modeIcons = {
  none: GroupsRounded,
  bookends: PersonRounded,
  facilitated: AutoAwesomeRounded,
} satisfies Record<MeetingModeratorMode, typeof GroupsRounded>;

export default function MeetingWizard({
  open,
  submitting = false,
  error,
  initialInput,
  onClose,
  onSubmit,
}: MeetingWizardProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [step, setStep] = useState(0);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [flowLoadError, setFlowLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [openingPrompt, setOpeningPrompt] = useState('');
  const [openingMedia, setOpeningMedia] = useState<ModelMediaPart[]>([]);
  const [participants, setParticipants] = useState<DraftParticipant[]>([]);
  const [moderatorMode, setModeratorMode] = useState<MeetingModeratorMode>('none');
  const [moderatorParticipantId, setModeratorParticipantId] = useState('');
  const [maxRounds, setMaxRounds] = useState(6);
  const [concurrencyLimit, setConcurrencyLimit] = useState(4);
  const [finishThreshold, setFinishThreshold] = useState<MeetingPolicy['finishThreshold']>('majority');
  const [errorStrategy, setErrorStrategy] = useState<MeetingPolicy['errorStrategy']>('collect-all');

  useEffect(() => {
    if (!open) return;
    setFlowsLoading(true);
    setFlowLoadError(null);
    flowService.loadFlows()
      .then(setFlows)
      .catch((loadError) => {
        setFlows([]);
        setFlowLoadError(loadError instanceof Error ? loadError.message : t('meetings.participants.loadError'));
      })
      .finally(() => setFlowsLoading(false));
  }, [open, t]);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTitle(initialInput?.title ?? '');
    setOpeningPrompt(initialInput?.openingPrompt ?? '');
    setOpeningMedia(initialInput?.openingMedia?.map((part) => ({ ...part })) ?? []);
    setParticipants(initialInput?.participants.map((participant) => ({
      id: participant.id ?? makeId(),
      flowId: participant.flowId,
      personaId: participant.personaId,
      behaviorSlotKey: participant.behaviorSlotKey,
      flowName: participant.name,
      name: participant.name,
    })) ?? []);
    setModeratorMode(initialInput?.policy?.moderatorMode ?? 'none');
    setModeratorParticipantId(initialInput?.moderatorParticipantId ?? '');
    setMaxRounds(initialInput?.policy?.maxRounds ?? 6);
    setConcurrencyLimit(initialInput?.policy?.concurrencyLimit ?? 4);
    setFinishThreshold(initialInput?.policy?.finishThreshold ?? 'majority');
    setErrorStrategy(initialInput?.policy?.errorStrategy ?? 'collect-all');
  }, [initialInput, open]);

  useEffect(() => {
    if (!flows.length) return;
    setParticipants((current) => current.map((participant) => ({
      ...participant,
      flowName: flows.find((flow) => flow.id === participant.flowId)?.name ?? participant.flowName,
    })));
  }, [flows]);

  useEffect(() => {
    // Participant selection happens before facilitation, so arrive on that
    // step with a useful parallel default instead of inheriting the temporary
    // one-agent clamp from the first card selected.
    setConcurrencyLimit(initialInput?.policy?.concurrencyLimit
      ?? Math.max(1, Math.min(4, participants.length || 1)));
  }, [initialInput?.policy?.concurrencyLimit, participants]);

  useEffect(() => {
    if (moderatorParticipantId && !participants.some((person) => person.id === moderatorParticipantId)) {
      setModeratorParticipantId('');
    }
  }, [moderatorParticipantId, participants]);

  const duplicateAliases = useMemo(() => {
    const counts = new Map<string, number>();
    for (const participant of participants) {
      const key = participant.name.trim().toLocaleLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }, [participants]);

  const stepValid = [
    title.trim().length >= 3 && openingPrompt.trim().length >= 10,
    participants.length >= 2
      && participants.every((person) => person.name.trim().length > 0)
      && duplicateAliases.size === 0,
    moderatorMode === 'none' || Boolean(moderatorParticipantId),
    true,
  ][step];

  const reset = () => {
    setStep(0);
    setTitle('');
    setOpeningPrompt('');
    setOpeningMedia([]);
    setParticipants([]);
    setModeratorMode('none');
    setModeratorParticipantId('');
    setMaxRounds(6);
    setConcurrencyLimit(4);
    setFinishThreshold('majority');
    setErrorStrategy('collect-all');
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const toggleFlow = (flow: Flow) => {
    setParticipants((current) => {
      const existing = current.find((person) => person.flowId === flow.id);
      if (existing) return current.filter((person) => person.id !== existing.id);
      return [...current, {
        id: makeId(),
        flowId: flow.id,
        flowName: flow.name,
        name: flow.name,
      }];
    });
  };

  const submit = () => {
    const input: CreateMeetingInput = {
      title: title.trim(),
      openingPrompt: openingPrompt.trim(),
      openingMedia: openingMedia.length ? openingMedia : undefined,
      participants: participants.map((participant) => ({
        id: participant.id,
        flowId: participant.flowId,
        personaId: participant.personaId,
        behaviorSlotKey: participant.behaviorSlotKey,
        name: participant.name.trim(),
        role: moderatorMode !== 'none' && participant.id === moderatorParticipantId
          ? 'moderator'
          : 'participant',
      })),
      moderatorParticipantId: moderatorMode === 'none' ? undefined : moderatorParticipantId,
      policy: {
        maxRounds,
        concurrencyLimit,
        moderatorMode,
        finishThreshold,
        errorStrategy,
        allSilentBehavior: 'finish',
      },
      parentMeetingId: initialInput?.parentMeetingId,
    };
    void onSubmit(input);
  };

  const attachFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const read = (file: File) => new Promise<ModelMediaPart>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
      reader.onload = () => {
        const result = String(reader.result ?? '');
        resolve({
          type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file',
          mimeType: file.type || 'application/octet-stream',
          data: result.includes(',') ? result.slice(result.indexOf(',') + 1) : result,
          name: file.name,
        });
      };
      reader.readAsDataURL(file);
    });
    const next = await Promise.all(Array.from(files).map(read));
    setOpeningMedia((current) => [...current, ...next].slice(0, 8));
  };

  const steps = [
    t('meetings.wizard.step.topic'),
    t('meetings.wizard.step.participants'),
    t('meetings.wizard.step.facilitation'),
    t('meetings.wizard.step.review'),
  ];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="md"
      PaperProps={{
        sx: {
          minHeight: { sm: 680 },
          overflow: 'hidden',
          border: { sm: `1px solid ${alpha(theme.palette.primary.main, 0.2)}` },
          backgroundImage: `linear-gradient(145deg, ${alpha(theme.palette.primary.main, 0.045)}, transparent 34%)`,
        },
      }}
    >
      <DialogHeaderActions
        onClose={handleClose}
        showAskFlujo={false}
        showBugReport={false}
        title={<Stack direction="row" alignItems="center" spacing={1.4}><Avatar sx={{ width: 42, height: 42, bgcolor: alpha(theme.palette.primary.main, 0.14), color: 'primary.light' }}><GroupsRounded /></Avatar><Box><Typography variant="overline" color="primary.light" sx={{ letterSpacing: '0.12em' }}>{initialInput?.parentMeetingId ? t('meetings.followup') : t('meetings.experimental')}</Typography><Typography variant="h6" component="div" sx={{ fontWeight: 750 }}>{t('meetings.wizard.title')}</Typography></Box></Stack>}
      />

      <Box sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
        <Stepper
          activeStep={step}
          alternativeLabel={!fullScreen}
          orientation={fullScreen ? 'horizontal' : 'horizontal'}
          sx={{
            '& .MuiStepLabel-label': { fontSize: { xs: '0.7rem', sm: '0.82rem' } },
            '& .MuiStepIcon-root.Mui-active': { filter: `drop-shadow(0 0 8px ${alpha(theme.palette.primary.main, 0.5)})` },
          }}
        >
          {steps.map((label) => (
            <Step key={label}><StepLabel>{label}</StepLabel></Step>
          ))}
        </Stepper>
      </Box>
      <Divider />

      <DialogContent sx={{ px: { xs: 2, sm: 4 }, py: 3 }}>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {step === 0 && (
          <Stack spacing={2.6} sx={{ maxWidth: 680, mx: 'auto' }}>
            <Paper variant="outlined" sx={{ p: 2.25, background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.1)}, ${alpha(theme.palette.secondary.main, 0.04)})` }}>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Avatar sx={{ bgcolor: 'primary.main' }}><AutoAwesomeRounded /></Avatar>
                <Box>
              <Typography variant="h5" sx={{ fontWeight: 760, letterSpacing: '-0.025em' }}>
                {t('meetings.topic.title')}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.6 }}>
                {t('meetings.topic.description')}
              </Typography>
                </Box>
              </Stack>
            </Paper>
            <TextField
              autoFocus
              fullWidth
              label={t('meetings.topic.name')}
              placeholder={t('meetings.topic.namePlaceholder')}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              inputProps={{ maxLength: 120 }}
              helperText={title.length > 0 && title.trim().length < 3 ? t('meetings.topic.nameHelp') : ' '}
            />
            <TextField
              fullWidth
              multiline
              minRows={7}
              label={t('meetings.topic.prompt')}
              placeholder={t('meetings.topic.promptPlaceholder')}
              value={openingPrompt}
              onChange={(event) => setOpeningPrompt(event.target.value)}
              inputProps={{ maxLength: 12_000 }}
              helperText={t('meetings.topic.promptHelp')}
            />
            <Box>
              <Button component="label" variant="outlined" startIcon={<AttachFileRounded />}>
                {t('meetings.attachments.add')}
                <Box component="input" type="file" multiple hidden onChange={(event) => { void attachFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>{t('meetings.attachments.help')}</Typography>
              {openingMedia.length > 0 && (
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                  {openingMedia.map((part, index) => (
                    <Chip key={`${part.name}-${index}`} icon={<DescriptionRounded />} label={part.name ?? t('meetings.attachments.file')} onDelete={() => setOpeningMedia((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
                  ))}
                </Stack>
              )}
            </Box>
            <Paper
              variant="outlined"
              sx={{ p: 2, display: 'flex', gap: 1.5, bgcolor: alpha(theme.palette.info.main, 0.045) }}
            >
              <AutoAwesomeRounded color="info" sx={{ mt: 0.2 }} />
              <Box>
                <Typography variant="subtitle2">{t('meetings.topic.tipTitle')}</Typography>
                <Typography variant="body2" color="text.secondary">{t('meetings.topic.tip')}</Typography>
              </Box>
            </Paper>
          </Stack>
        )}

        {step === 1 && (
          <Stack spacing={2.4}>
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h5" sx={{ fontWeight: 760, letterSpacing: '-0.025em' }}>
                  {t('meetings.participants.title')}
                </Typography>
                <Chip
                  size="small"
                  color={participants.length >= 2 ? 'success' : 'default'}
                  label={t('meetings.participants.selected', { count: participants.length })}
                />
              </Stack>
              <Typography color="text.secondary" sx={{ mt: 0.6 }}>
                {t('meetings.participants.description')}
              </Typography>
            </Box>

            {flowsLoading ? (
              <Stack alignItems="center" spacing={1.5} sx={{ py: 8 }}>
                <CircularProgress size={30} />
                <Typography color="text.secondary">{t('meetings.participants.loading')}</Typography>
              </Stack>
            ) : flowLoadError ? (
              <Alert severity="error">{flowLoadError}</Alert>
            ) : flows.length === 0 ? (
              <Alert severity="info" action={<Button href="/flows">{t('meetings.participants.createAgent')}</Button>}>
                {t('meetings.participants.empty')}
              </Alert>
            ) : (
              <Box sx={{ maxHeight: 310, overflowY: 'auto', pr: 0.5 }}>
                <CardPickerGrid
                  searchable
                  stickySearch
                  columns={{ xs: 12, sm: 6, md: 6 }}
                  searchPlaceholder={t('meetings.participants.search')}
                  items={flows.map((flow) => {
                  const selected = participants.some((person) => person.flowId === flow.id);
                  return { key: flow.id, searchText: `${flow.name} ${flow.description ?? ''}`, content: (
                    <Card
                      variant="outlined"
                      sx={{
                        borderColor: selected ? 'primary.main' : 'divider',
                        bgcolor: selected ? alpha(theme.palette.primary.main, 0.07) : undefined,
                        boxShadow: selected ? `0 0 0 1px ${alpha(theme.palette.primary.main, 0.24)}` : undefined,
                      }}
                    >
                      <CardActionArea onClick={() => toggleFlow(flow)} sx={{ p: 1.6 }}>
                        <Stack direction="row" spacing={1.4} alignItems="center">
                          <Avatar sx={{ bgcolor: selected ? 'primary.main' : alpha(theme.palette.text.primary, 0.08) }}>
                            {selected ? <CheckCircleRounded /> : <PersonRounded />}
                          </Avatar>
                          <Box sx={{ flex: 1, minWidth: 0 }}>
                            <Typography fontWeight={700} noWrap>{flow.name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {t('meetings.participants.steps', { count: flow.nodes.length })}
                            </Typography>
                          </Box>
                          {selected ? <RemoveCircleOutlineRounded color="primary" /> : <AddRounded color="action" />}
                        </Stack>
                      </CardActionArea>
                    </Card>
                  ) };
                })}
                />
              </Box>
            )}

            {participants.length > 0 && (
              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('meetings.participants.aliases')}</Typography>
                <Stack spacing={1}>
                  {participants.map((participant, index) => {
                    const duplicate = duplicateAliases.has(participant.name.trim().toLocaleLowerCase());
                    return (
                      <Paper key={participant.id} variant="outlined" sx={{ p: 1.25 }}>
                        <Stack direction="row" spacing={1.2} alignItems="center">
                          <Avatar sx={{ width: 34, height: 34, fontSize: '0.85rem', bgcolor: 'primary.dark' }}>
                            {index + 1}
                          </Avatar>
                          <TextField
                            size="small"
                            fullWidth
                            label={t('meetings.participants.alias')}
                            value={participant.name}
                            error={duplicate || !participant.name.trim()}
                            helperText={duplicate ? t('meetings.participants.aliasDuplicate') : participant.flowName}
                            onChange={(event) => setParticipants((current) => current.map((person) => (
                              person.id === participant.id ? { ...person, name: event.target.value } : person
                            )))}
                          />
                          <Tooltip title={t('meetings.participants.remove')}>
                            <IconButton onClick={() => setParticipants((current) => current.filter((person) => person.id !== participant.id))}>
                              <CloseRounded />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </Paper>
                    );
                  })}
                </Stack>
              </Box>
            )}

            {participants.length < 2 && (
              <Alert severity="warning">{t('meetings.participants.minimum')}</Alert>
            )}
          </Stack>
        )}

        {step === 2 && (
          <Stack spacing={3} sx={{ maxWidth: 760, mx: 'auto' }}>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 760, letterSpacing: '-0.025em' }}>
                {t('meetings.facilitation.title')}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.6 }}>
                {t('meetings.facilitation.description')}
              </Typography>
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1.25 }}>
              {(['none', 'bookends', 'facilitated'] as const).map((mode) => {
                const selected = moderatorMode === mode;
                const Icon = modeIcons[mode];
                return (
                  <Card
                    key={mode}
                    variant="outlined"
                    sx={{ borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? alpha(theme.palette.primary.main, 0.07) : undefined }}
                  >
                    <CardActionArea
                      onClick={() => {
                        setModeratorMode(mode);
                        if (mode === 'none') setModeratorParticipantId('');
                      }}
                      sx={{ height: '100%', p: 2 }}
                    >
                      <Stack spacing={1}>
                        <Icon color={selected ? 'primary' : 'action'} />
                        <Typography fontWeight={720}>{t(`meetings.facilitation.mode.${mode}`)}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {t(`meetings.facilitation.mode.${mode}Help`)}
                        </Typography>
                      </Stack>
                    </CardActionArea>
                  </Card>
                );
              })}
            </Box>

            {moderatorMode !== 'none' && (
              <FormControl fullWidth>
                <FormLabel sx={{ mb: 1 }}>{t('meetings.facilitation.moderator')}</FormLabel>
                <Select
                  value={moderatorParticipantId}
                  displayEmpty
                  onChange={(event) => setModeratorParticipantId(event.target.value)}
                >
                  <MenuItem value="" disabled>{t('meetings.facilitation.chooseModerator')}</MenuItem>
                  {participants.map((participant) => (
                    <MenuItem key={participant.id} value={participant.id}>{participant.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
              <Stack spacing={3}>
                <Box>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Box>
                      <Typography fontWeight={700}>{t('meetings.facilitation.rounds')}</Typography>
                      <Typography variant="body2" color="text.secondary">{t('meetings.facilitation.roundsHelp')}</Typography>
                    </Box>
                    <Chip label={t('meetings.facilitation.roundCount', { count: maxRounds })} color="primary" variant="outlined" />
                  </Stack>
                  <Slider value={maxRounds} min={1} max={12} step={1} marks={[{ value: 1, label: '1' }, { value: 6, label: '6' }, { value: 12, label: '12' }]} onChange={(_, value) => setMaxRounds(value as number)} />
                </Box>
                <Divider />
                <Box>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Box>
                      <Typography fontWeight={700}>{t('meetings.facilitation.concurrency')}</Typography>
                      <Typography variant="body2" color="text.secondary">{t('meetings.facilitation.concurrencyHelp')}</Typography>
                    </Box>
                    <Chip label={concurrencyLimit} variant="outlined" />
                  </Stack>
                  <Slider
                    value={concurrencyLimit}
                    min={1}
                    max={Math.max(1, Math.min(8, participants.length))}
                    step={1}
                    onChange={(_, value) => setConcurrencyLimit(value as number)}
                  />
                </Box>
              </Stack>
            </Paper>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <FormControl>
                <FormLabel><Stack direction="row" spacing={0.7} alignItems="center"><HowToVoteRounded fontSize="small" /><span>{t('meetings.facilitation.finishRule')}</span></Stack></FormLabel>
                <RadioGroup value={finishThreshold} onChange={(event) => setFinishThreshold(event.target.value as MeetingPolicy['finishThreshold'])}>
                  <FormControlLabel value="majority" control={<Radio />} label={t('meetings.facilitation.majority')} />
                  <FormControlLabel value="unanimous" control={<Radio />} label={t('meetings.facilitation.unanimous')} />
                </RadioGroup>
              </FormControl>
              <FormControl>
                <FormLabel><Stack direction="row" spacing={0.7} alignItems="center"><ShieldRounded fontSize="small" /><span>{t('meetings.facilitation.errors')}</span></Stack></FormLabel>
                <RadioGroup value={errorStrategy} onChange={(event) => setErrorStrategy(event.target.value as MeetingPolicy['errorStrategy'])}>
                  <FormControlLabel value="collect-all" control={<Radio />} label={t('meetings.facilitation.keepGoing')} />
                  <FormControlLabel value="fail-fast" control={<Radio />} label={t('meetings.facilitation.stopOnError')} />
                </RadioGroup>
              </FormControl>
            </Box>
          </Stack>
        )}

        {step === 3 && (
          <Stack spacing={2.5} sx={{ maxWidth: 760, mx: 'auto' }}>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 760, letterSpacing: '-0.025em' }}>
                {t('meetings.review.title')}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.6 }}>{t('meetings.review.description')}</Typography>
            </Box>
            <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
              <Typography variant="overline" color="primary.light">{t('meetings.review.topic')}</Typography>
              <Typography variant="h6" sx={{ fontWeight: 740 }}>{title}</Typography>
              <Typography sx={{ mt: 1, whiteSpace: 'pre-wrap' }} color="text.secondary">{openingPrompt}</Typography>
              {openingMedia.length > 0 && <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>{openingMedia.map((part, index) => <Chip key={`${part.name}-${index}`} size="small" icon={<DescriptionRounded />} label={part.name ?? t('meetings.attachments.file')} />)}</Stack>}
            </Paper>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="overline" color="text.secondary">{t('meetings.review.team')}</Typography>
                <Stack spacing={1} sx={{ mt: 0.5 }}>
                  {participants.map((participant) => (
                    <Stack key={participant.id} direction="row" spacing={1} alignItems="center">
                      <Avatar sx={{ width: 30, height: 30, fontSize: '0.75rem' }}>{participant.name.slice(0, 2).toUpperCase()}</Avatar>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="body2" fontWeight={700} noWrap>{participant.name}</Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>{participant.flowName}</Typography>
                      </Box>
                      {participant.id === moderatorParticipantId && <Chip size="small" label={t('meetings.moderator')} color="secondary" />}
                    </Stack>
                  ))}
                </Stack>
              </Paper>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="overline" color="text.secondary">{t('meetings.review.format')}</Typography>
                <Stack spacing={1.2} sx={{ mt: 0.7 }}>
                  <Typography variant="body2"><strong>{t('meetings.review.facilitator')}:</strong> {t(`meetings.facilitation.mode.${moderatorMode}`)}</Typography>
                  <Typography variant="body2"><strong>{t('meetings.review.limit')}:</strong> {t('meetings.facilitation.roundCount', { count: maxRounds })}</Typography>
                  <Typography variant="body2"><strong>{t('meetings.review.parallel')}:</strong> {concurrencyLimit}</Typography>
                  <Typography variant="body2"><strong>{t('meetings.review.consensus')}:</strong> {t(`meetings.facilitation.${finishThreshold}`)}</Typography>
                </Stack>
              </Paper>
            </Box>
            <Alert severity="info" icon={<AutoAwesomeRounded />}>
              {t('meetings.review.startHelp')}
            </Alert>
            <Alert severity="warning" icon={<ShieldRounded />}>
              {t('meetings.review.unattendedTools')}
            </Alert>
          </Stack>
        )}
      </DialogContent>

      <Divider />
      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2, justifyContent: 'space-between' }}>
        <Button onClick={step === 0 ? handleClose : () => setStep((current) => current - 1)} disabled={submitting}>
          {step === 0 ? t('common.cancel') : t('common.back')}
        </Button>
        {step < 3 ? (
          <Button variant="contained" onClick={() => setStep((current) => current + 1)} disabled={!stepValid}>
            {t('common.next')}
          </Button>
        ) : (
          <Button
            variant="contained"
            size="large"
            startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : <GroupsRounded />}
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? t('meetings.review.starting') : t('meetings.review.start')}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
