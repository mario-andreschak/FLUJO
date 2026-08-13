"use client";

import {
  AddRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  ContentCopyRounded,
  EditRounded,
  OpenInNewRounded,
  PlayArrowRounded,
  RestartAltRounded,
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

import FlowCard, {
  FlowCardSkeleton,
} from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import CardPickerDialog from '@/frontend/components/shared/CardPickerDialog';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useCardPicker } from '@/frontend/hooks/useCardPicker';
import { flowService } from '@/frontend/services/flow';
import {
  personasService,
  type PersonaDetail,
} from '@/frontend/services/personas';
import type { Flow } from '@/frontend/types/flow/flow';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type {
  PersonaBehaviorComposition,
  PersonaBehaviorFlowCard,
  PersonaComposition,
  PersonaFlowBinding,
  PersonaFlowCard,
  UpdatePersonaBehaviorComposition,
} from '@/shared/types/enduringAgent';

type PickerTarget =
  | { kind: 'core' }
  | { kind: 'behavior'; ref: string }
  | { kind: 'add'; ref: string; slotKey: string; name: string; description?: string };

function updateBehavior(
  behavior: PersonaBehaviorComposition,
  index: number,
): UpdatePersonaBehaviorComposition | null {
  const binding = behavior.binding ?? (
    behavior.overrideFlowRef
      ? {
          mode: 'persona_copy' as const,
          ...(behavior.sourceFlowRef ? { sharedFlowRef: behavior.sourceFlowRef } : {}),
          personaFlowRef: behavior.overrideFlowRef,
        }
      : behavior.sourceFlowRef
        ? { mode: 'shared' as const, sharedFlowRef: behavior.sourceFlowRef }
        : null
  );
  if (!binding) return null;
  return {
    ref: behavior.ref,
    ...(behavior.slotKey ? { slotKey: behavior.slotKey } : {}),
    name: behavior.name,
    ...(behavior.description ? { description: behavior.description } : {}),
    order: behavior.order ?? index,
    binding,
  };
}

export default function PersonaFlowsArea({
  detail,
  onChanged,
}: {
  detail: PersonaDetail;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [composition, setComposition] = useState<PersonaComposition | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [rename, setRename] = useState<PersonaBehaviorFlowCard | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextComposition, nextFlows] = await Promise.all([
        personasService.getComposition(detail.persona.id),
        flowService.loadFlows(),
      ]);
      setComposition(nextComposition);
      setFlows(nextFlows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.flows.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [detail.persona.id, t]);

  useEffect(() => { void load(); }, [load]);

  const pickerModel = useCardPicker<Flow>(
    'flows',
    flows.filter((flow) => !flow.personaOwnership),
  );

  const persistBehaviors = async (
    next: PersonaBehaviorComposition[],
    expectedUpdatedAt = composition!.expectedUpdatedAt,
  ) => {
    const behaviors = next
      .map(updateBehavior)
      .filter((item): item is UpdatePersonaBehaviorComposition => item !== null)
      .map((item, order) => ({ ...item, order }));
    return personasService.updateComposition(detail.persona.id, {
      expectedUpdatedAt,
      behaviors,
    });
  };

  const complete = async (action: () => Promise<PersonaComposition>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setComposition(await action());
      setPicker(null);
      setRename(null);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const applyFlow = (flow: Flow) => complete(async () => {
    if (!composition || !picker) throw new Error(t('personas.flows.loadFailed'));
    if (picker.kind === 'core') {
      return personasService.updateComposition(detail.persona.id, {
        expectedUpdatedAt: composition.expectedUpdatedAt,
        coreFlowRef: flow.id,
      });
    }
    const binding: PersonaFlowBinding = { mode: 'shared', sharedFlowRef: flow.id };
    const existing = composition.behaviors.map((behavior) => ({ ...behavior }));
    if (picker.kind === 'add') {
      existing.push({
        ref: picker.ref,
        slotKey: picker.slotKey,
        name: picker.name,
        ...(picker.description ? { description: picker.description } : {}),
        order: existing.length,
        binding,
      });
    } else {
      const index = existing.findIndex((behavior) => behavior.ref === picker.ref);
      if (index < 0) throw new Error(t('personas.behaviors.missing'));
      existing[index] = {
        ...existing[index],
        binding,
        sourceFlowRef: flow.id,
        overrideFlowRef: undefined,
      };
    }
    return persistBehaviors(existing);
  });

  const copyFlow = (flow: Flow) => complete(async () => {
    if (!composition || !picker) throw new Error(t('personas.flows.loadFailed'));
    let expectedUpdatedAt = composition.expectedUpdatedAt;
    if (picker.kind === 'add') {
      const next = [...composition.behaviors, {
        ref: picker.ref,
        slotKey: picker.slotKey,
        name: picker.name,
        ...(picker.description ? { description: picker.description } : {}),
        order: composition.behaviors.length,
        binding: { mode: 'shared' as const, sharedFlowRef: flow.id },
      }];
      const added = await persistBehaviors(next, expectedUpdatedAt);
      expectedUpdatedAt = added.expectedUpdatedAt;
    }
    const result = await personasService.copyCompositionFlow(detail.persona.id, {
      expectedUpdatedAt,
      target: picker.kind === 'core' ? 'core' : 'behavior',
      ...(picker.kind !== 'core' ? { behaviorRef: picker.ref } : {}),
      sourceFlowRef: flow.id,
    });
    setFlows((current) => [...current, result.flow as Flow]);
    return result.composition;
  });

  const move = (ref: string, delta: number) => {
    if (!composition) return;
    const next = [...composition.behaviors];
    const index = next.findIndex((behavior) => behavior.ref === ref);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void complete(() => persistBehaviors(next));
  };

  const remove = (ref: string) => {
    if (!composition) return;
    void complete(() => persistBehaviors(
      composition.behaviors.filter((behavior) => behavior.ref !== ref),
    ));
  };

  const reset = (card: PersonaBehaviorFlowCard) => {
    if (!composition || card.binding.mode !== 'persona_copy' || !card.binding.sharedFlowRef) return;
    const next = composition.behaviors.map((behavior) => behavior.ref === card.ref
      ? {
          ...behavior,
          binding: {
            mode: 'shared' as const,
            sharedFlowRef: card.binding.sharedFlowRef!,
          },
          sourceFlowRef: card.binding.sharedFlowRef,
          overrideFlowRef: undefined,
        }
      : behavior);
    void complete(() => persistBehaviors(next));
  };

  const resetCore = () => {
    if (!composition || composition.core?.binding.mode !== 'persona_copy') return;
    const sharedFlowRef = composition.core.binding.sharedFlowRef;
    if (!sharedFlowRef) return;
    void complete(() => personasService.updateComposition(detail.persona.id, {
      expectedUpdatedAt: composition.expectedUpdatedAt,
      coreFlowRef: sharedFlowRef,
    }));
  };

  const saveRename = () => {
    if (!composition || !rename || !renameValue.trim()) return;
    const next = composition.behaviors.map((behavior) => behavior.ref === rename.ref
      ? { ...behavior, name: renameValue.trim() }
      : behavior);
    void complete(() => persistBehaviors(next));
  };

  const configured = new Set(composition?.behaviors.map((behavior) => behavior.ref) ?? []);
  const availableBindings = detail.behaviorBindings.filter((binding) => !configured.has(binding.id));
  const pickerItems = pickerModel.items.map((flow) => ({
    key: flow.id,
    label: flow.name,
    searchText: `${flow.name} ${flow.description ?? ''}`,
    content: (
      <Stack spacing={1.25} sx={{ height: '100%' }}>
        <FlowCard flow={flow} selected={false} pickerMode selectionManaged onSelect={() => {}} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button fullWidth variant="contained" onClick={() => void applyFlow(flow)}>
            {t('personas.behaviors.useShared')}
          </Button>
          <Button fullWidth variant="outlined" startIcon={<ContentCopyRounded />} onClick={() => void copyFlow(flow)}>
            {t('personas.behaviors.makeCopy')}
          </Button>
        </Stack>
      </Stack>
    ),
  }));

  if (loading) {
    return <Paper variant="outlined" sx={{ p: 4, borderRadius: 4 }}><Stack alignItems="center"><CircularProgress /></Stack></Paper>;
  }
  if (!composition) {
    return <Alert severity="error" action={<Button onClick={() => void load()}>{t('personas.retry')}</Button>}>{error ?? t('personas.flows.loadFailed')}</Alert>;
  }

  return (
    <Stack spacing={2}>
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      <Alert severity="info">{t('personas.behaviors.futureActivity')}</Alert>
      <FlowSection
        title={t('personas.behaviors.core')}
        description={t('personas.behaviors.coreContext')}
        card={composition.core}
        busy={busy}
        onChange={() => setPicker({ kind: 'core' })}
        onReset={composition.core?.binding.mode === 'persona_copy'
          && composition.core.binding.sharedFlowRef
          ? resetCore
          : undefined}
        personaId={detail.persona.id}
      />
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1} sx={{ mb: 2 }}>
          <Box>
            <Typography variant="h5" fontWeight={760}>{t('personas.behaviors.title')}</Typography>
            <Typography color="text.secondary">{t('personas.behaviors.description')}</Typography>
          </Box>
          {availableBindings.length > 0 && (
            <Button
              startIcon={<AddRounded />}
              onClick={() => {
                const binding = availableBindings[0];
                const slot = detail.roleVersion.behaviorSlots.find((item) => item.key === binding.slotKey);
                setPicker({
                  kind: 'add',
                  ref: binding.id,
                  slotKey: binding.slotKey,
                  name: slot?.name ?? binding.slotKey,
                  ...(slot?.description ? { description: slot.description } : {}),
                });
              }}
            >
              {t('personas.behaviors.add')}
            </Button>
          )}
        </Stack>
        {composition.behaviorCards.length === 0 ? (
          <Typography color="text.secondary">{t('personas.behaviors.empty')}</Typography>
        ) : (
          <Stack spacing={2}>
            {composition.behaviorCards.map((card, index) => (
              <Card key={card.ref} variant="outlined" sx={{ borderRadius: 3 }}>
                <CardContent>
                  <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
                    <Box>
                      <Typography variant="h6" fontWeight={750}>{card.name}</Typography>
                      {card.description && <Typography color="text.secondary">{card.description}</Typography>}
                    </Box>
                    <ReadinessChip card={card} />
                  </Stack>
                  <Box sx={{ mt: 2 }}>
                    {card.flow
                      ? <FlowCard flow={card.flow as Flow} selected pickerMode selectionManaged onSelect={() => {}} />
                      : <Alert severity="warning">{t('personas.behaviors.missing')}</Alert>}
                  </Box>
                </CardContent>
                <CardActions sx={{ flexWrap: 'wrap', gap: 0.5, px: 2, pb: 2 }}>
                  <Button disabled={busy} onClick={() => setPicker({ kind: 'behavior', ref: card.ref })}>{card.flow ? t('personas.behaviors.change') : t('personas.behaviors.replace')}</Button>
                  <FlowLinks card={card} personaId={detail.persona.id} />
                  <Button disabled={busy} startIcon={<EditRounded />} onClick={() => { setRename(card); setRenameValue(card.name); }}>{t('personas.behaviors.rename')}</Button>
                  <Button disabled={busy || index === 0} aria-label={t('personas.behaviors.moveUp')} onClick={() => move(card.ref, -1)}><ArrowUpwardRounded /></Button>
                  <Button disabled={busy || index === composition.behaviorCards.length - 1} aria-label={t('personas.behaviors.moveDown')} onClick={() => move(card.ref, 1)}><ArrowDownwardRounded /></Button>
                  {card.binding.mode === 'persona_copy' && card.binding.sharedFlowRef && (
                    <Button disabled={busy} startIcon={<RestartAltRounded />} onClick={() => reset(card)}>{t('personas.behaviors.resetShared')}</Button>
                  )}
                  <Button color="error" disabled={busy} onClick={() => remove(card.ref)}>{t('personas.behaviors.remove')}</Button>
                </CardActions>
              </Card>
            ))}
          </Stack>
        )}
      </Paper>

      <CardPickerDialog
        open={picker !== null}
        onClose={() => setPicker(null)}
        title={t('personas.behaviors.chooseFlow')}
        description={t('personas.behaviors.chooseHelp')}
        searchable
        searchTerm={pickerModel.searchTerm}
        onSearchChange={pickerModel.setSearchTerm}
        searchPlaceholder={t('flows.dashboard.search')}
        isLoading={false}
        emptyMessage={t('chat.selector.empty')}
        skeleton={<FlowCardSkeleton />}
        items={pickerItems}
      />
      <Dialog open={rename !== null} onClose={() => setRename(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('personas.behaviors.rename')}</DialogTitle>
        <DialogContent dividers>
          <TextField autoFocus fullWidth label={t('personas.behaviors.name')} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRename(null)}>{t('personas.action.cancel')}</Button>
          <Button variant="contained" disabled={!renameValue.trim() || busy} onClick={saveRename}>{t('personas.action.save')}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function FlowSection({
  title,
  description,
  card,
  busy,
  onChange,
  onReset,
  personaId,
}: {
  title: string;
  description: string;
  card?: PersonaFlowCard;
  busy: boolean;
  onChange: () => void;
  onReset?: () => void;
  personaId: string;
}) {
  const { t } = useI18n();
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
        <Box><Typography variant="h5" fontWeight={760}>{title}</Typography><Typography color="text.secondary">{description}</Typography></Box>
        {card && <ReadinessChip card={card} />}
      </Stack>
      <Box sx={{ mt: 2 }}>
        {card?.flow
          ? <FlowCard flow={card.flow as Flow} selected pickerMode selectionManaged onSelect={() => {}} />
          : <Alert severity="warning">{t('personas.behaviors.missing')}</Alert>}
      </Box>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
        <Button disabled={busy} onClick={onChange}>{card?.flow ? t('personas.behaviors.change') : t('personas.behaviors.replace')}</Button>
        {card && <FlowLinks card={card} personaId={personaId} />}
        {onReset && (
          <Button disabled={busy} startIcon={<RestartAltRounded />} onClick={onReset}>
            {t('personas.behaviors.resetShared')}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}

function ReadinessChip({ card }: { card: PersonaFlowCard }) {
  const { t } = useI18n();
  const color = card.readiness.state === 'ready' ? 'success' : card.readiness.state === 'missing' ? 'error' : 'warning';
  return <Chip color={color} label={t(`personas.behaviors.${card.readiness.state}`)} />;
}

function FlowLinks({ card, personaId }: { card: PersonaFlowCard; personaId: string }) {
  const { t } = useI18n();
  if (!card.flow || card.readiness.state === 'missing') return null;
  const returnTo = `/personas/${encodeURIComponent(personaId)}?area=setup&section=behaviors`;
  const builder = `/flows?flow=${encodeURIComponent(card.effectiveFlowRef)}&mode=edit&returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <>
      <Button component={Link} href={withWorkspaceUrl(builder)} startIcon={<OpenInNewRounded />}>{t('personas.behaviors.openBuilder')}</Button>
      <Button component={Link} href={withWorkspaceUrl(`/chat?flow=${encodeURIComponent(card.effectiveFlowRef)}`)} disabled={card.readiness.state !== 'ready'} startIcon={<PlayArrowRounded />}>{t('personas.behaviors.runTest')}</Button>
    </>
  );
}
