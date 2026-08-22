"use client";

import {
  EditRounded,
  HistoryRounded,
  MemoryRounded,
  PushPinRounded,
  WarningAmberRounded,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { FEATURES } from '@/config/features';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import {
  PersonasApiError,
  personasService,
  type MemorySearchResult,
  type PersonaDetail,
} from '@/frontend/services/personas';
import type { MemoryItem } from '@/shared/types/enduringAgent';

type MemoryBucket = 'important' | 'remembered' | 'needsReview' | 'forgotten';
type OptimisticMemory = {
  status?: MemoryItem['status'];
  core?: boolean;
};
type BulkReviewState = {
  operation: 'approve' | 'forget';
  completed: number;
  total: number;
  failedIds: string[];
};
type BulkReviewSummary = { succeeded: number; failed: number; skipped: number };
type ConflictPair = { memory: MemoryItem; counterpart: MemoryItem };

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_LIMIT = 20;

const BUCKETS: MemoryBucket[] = [
  'important',
  'remembered',
  'needsReview',
  'forgotten',
];

function memoryBucket(memory: MemoryItem, core: boolean): MemoryBucket | null {
  if (memory.status === 'candidate') return 'needsReview';
  if (memory.status === 'forgotten') return 'forgotten';
  if (memory.status !== 'active') return null;
  return core ? 'important' : 'remembered';
}

function actorKey(memory: MemoryItem): TranslationKey {
  if (memory.trust === 'explicit_user'
    || memory.sourceRefs.some((source) => source.kind === 'user_statement')) {
    return 'personas.memory.addedByYou';
  }
  if (memory.trust === 'model_inference') return 'personas.memory.suggestedByPersona';
  if (memory.trust === 'verified_tool') return 'personas.memory.verifiedTool';
  return 'personas.memory.externalEvidence';
}

function earlierMemoryVersions(
  memory: MemoryItem,
  allMemories: readonly MemoryItem[],
): MemoryItem[] {
  const byId = new Map(allMemories.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const earlier: MemoryItem[] = [];
  const pending = [...(memory.supersedes ?? [])];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const candidate = byId.get(id);
    if (!candidate || candidate.personaId !== memory.personaId) continue;
    earlier.push(candidate);
    pending.push(...(candidate.supersedes ?? []));
  }
  return earlier;
}

function dateInputValue(timestamp: number | undefined): string {
  if (timestamp === undefined) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function expiryMessage(
  expiresAt: number | undefined,
  now: number,
): { key: TranslationKey; values?: { days: number } } | null {
  if (expiresAt === undefined) return null;
  const remaining = expiresAt - now;
  if (remaining <= 0) return { key: 'personas.memory.expired' };
  if (remaining <= DAY_MS) return { key: 'personas.memory.expiresToday' };
  return {
    key: 'personas.memory.expiresInDays',
    values: { days: Math.ceil(remaining / DAY_MS) },
  };
}

function availabilityTimestamp(
  value: string,
  original: number | undefined,
  boundary: 'start' | 'end',
): number | undefined {
  if (!value) return undefined;
  if (original !== undefined && value === dateInputValue(original)) return original;
  const [year, month, day] = value.split('-').map(Number);
  const date = boundary === 'start'
    ? new Date(year, month - 1, day, 0, 0, 0, 0)
    : new Date(year, month - 1, day, 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export default function PersonaMemoryArea({
  detail,
  busy,
  refresh,
}: {
  detail: PersonaDetail;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addContent, setAddContent] = useState('');
  const [addRequestId, setAddRequestId] = useState('');
  const [addValidFromDate, setAddValidFromDate] = useState('');
  const [addValidUntilDate, setAddValidUntilDate] = useState('');
  const [correction, setCorrection] = useState<MemoryItem | null>(null);
  const [correctionContent, setCorrectionContent] = useState('');
  const [correctionValidFromDate, setCorrectionValidFromDate] = useState('');
  const [correctionValidUntilDate, setCorrectionValidUntilDate] = useState('');
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null);
  const [provenanceOpen, setProvenanceOpen] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticMemory>>({});
  const [reviewResults, setReviewResults] = useState<MemorySearchResult[] | null>(null);
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [bulkReview, setBulkReview] = useState<BulkReviewState | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkReviewSummary | null>(null);
  const [conflictPair, setConflictPair] = useState<ConflictPair | null>(null);
  const [conflictReason, setConflictReason] = useState('');
  const [memoryError, setMemoryError] = useState<{
    message: string;
    code?: string;
    details?: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    if (!correction) return;
    const latest = detail.memoryItems.find((memory) => memory.id === correction.id);
    if (latest && latest.updatedAt !== correction.updatedAt) setCorrection(latest);
  }, [correction, detail.memoryItems]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => personasService.memories(detail.persona.id, {
      statuses: ['candidate'],
      order: 'review',
      limit: REVIEW_LIMIT,
    })).then((results) => {
      if (active) setReviewResults(results);
    }).catch(() => {
      if (active) setReviewResults(null);
    });
    return () => { active = false; };
  }, [detail.persona.id, detail.memoryItems]);

  const coreIds = useMemo(
    () => new Set(detail.persona.coreMemoryItemIds ?? []),
    [detail.persona.coreMemoryItemIds],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const reviewRank = useMemo(() => new Map(
    (reviewResults ?? []).map((result, index) => [result.item.id, index]),
  ), [reviewResults]);
  const detailById = useMemo(
    () => new Map(detail.memoryItems.map(memory => [memory.id, memory])),
    [detail.memoryItems],
  );
  const memories = useMemo(() => detail.memoryItems
    .map((memory) => ({
      ...(reviewResults?.find(result => result.item.id === memory.id)?.item ?? memory),
      status: optimistic[memory.id]?.status ?? memory.status,
    }))
    .filter((memory) => (
      memory.status !== 'superseded'
      && (memory.status !== 'candidate' || reviewResults === null || reviewRank.has(memory.id))
      && (!normalizedQuery || memory.content.toLocaleLowerCase().includes(normalizedQuery))
    ))
    .sort((left, right) => {
      if (left.status === 'candidate' && right.status === 'candidate') {
        return (reviewRank.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (reviewRank.get(right.id) ?? Number.MAX_SAFE_INTEGER);
      }
      return right.updatedAt - left.updatedAt;
    }), [
      detail.memoryItems,
      normalizedQuery,
      optimistic,
      reviewRank,
      reviewResults,
    ]);

  const visibleReviewIds = useMemo(
    () => memories.filter(memory => memory.status === 'candidate').map(memory => memory.id),
    [memories],
  );

  useEffect(() => {
    const visible = new Set(visibleReviewIds);
    setSelectedReviewIds(current => current.filter(id => visible.has(id)));
  }, [visibleReviewIds]);

  const isPending = busy || pendingKey !== null;
  const addValidFrom = availabilityTimestamp(addValidFromDate, undefined, 'start');
  const addValidUntil = availabilityTimestamp(addValidUntilDate, undefined, 'end');
  const addRangeInvalid = addValidFrom !== undefined
    && addValidUntil !== undefined
    && addValidUntil < addValidFrom;
  const correctionValidFrom = availabilityTimestamp(
    correctionValidFromDate,
    correction?.validFrom,
    'start',
  );
  const correctionValidUntil = availabilityTimestamp(
    correctionValidUntilDate,
    correction?.validUntil,
    'end',
  );
  const correctionRangeInvalid = correctionValidFrom !== undefined
    && correctionValidUntil !== undefined
    && correctionValidUntil < correctionValidFrom;

  const clearOptimistic = (memoryId: string) => {
    setOptimistic((current) => {
      const next = { ...current };
      delete next[memoryId];
      return next;
    });
  };

  const runMutation = async (
    key: string,
    action: () => Promise<unknown>,
    memoryId?: string,
    next?: OptimisticMemory,
  ): Promise<boolean> => {
    setPendingKey(key);
    setMemoryError(null);
    if (memoryId && next) {
      setOptimistic((current) => ({ ...current, [memoryId]: next }));
    }
    try {
      await action();
      await refresh();
      if (memoryId) clearOptimistic(memoryId);
      return true;
    } catch (cause) {
      if (memoryId) clearOptimistic(memoryId);
      const apiError = cause instanceof PersonasApiError ? cause : null;
      if (apiError?.status === 409) {
        await refresh().catch(() => undefined);
      }
      const message = apiError?.code === 'memory_changed'
        ? t('personas.memory.changed')
        : apiError?.code === 'core_memory_capacity'
          ? t('personas.memory.capacity', {
            current: String(apiError.details?.currentCoreItems ?? ''),
            max: String(apiError.details?.maxCoreItems ?? ''),
          })
          : cause instanceof Error
            ? cause.message
            : t('personas.action.failed');
      setMemoryError({
        message,
        code: apiError?.code,
        details: apiError?.details,
      });
      return false;
    } finally {
      setPendingKey(null);
    }
  };

  const runBulkReview = async (operation: 'approve' | 'forget') => {
    if (bulkReview || pendingKey !== null || selectedReviewIds.length === 0) return;
    const visible = new Set(visibleReviewIds);
    const ids = selectedReviewIds.filter(id => visible.has(id));
    const skipped = selectedReviewIds.length - ids.length;
    if (ids.length === 0) return;
    const failedIds: string[] = [];
    const succeededIds: string[] = [];
    setPendingKey(`bulk:${operation}`);
    setMemoryError(null);
    setBulkSummary(null);
    setBulkReview({ operation, completed: 0, total: ids.length, failedIds: [] });
    for (let index = 0; index < ids.length; index += 1) {
      const memoryId = ids[index];
      try {
        if (operation === 'approve') {
          await personasService.activateMemory(detail.persona.id, memoryId);
          setOptimistic(current => ({
            ...current,
            [memoryId]: { status: 'active' },
          }));
        } else {
          await personasService.forgetMemory(detail.persona.id, memoryId);
          setOptimistic(current => ({
            ...current,
            [memoryId]: { status: 'forgotten', core: false },
          }));
        }
        succeededIds.push(memoryId);
        setSelectedReviewIds(current => current.filter(id => id !== memoryId));
      } catch {
        failedIds.push(memoryId);
      }
      setBulkReview({
        operation,
        completed: index + 1,
        total: ids.length,
        failedIds: [...failedIds],
      });
    }
    await refresh().catch(() => undefined);
    succeededIds.forEach(clearOptimistic);
    setSelectedReviewIds(failedIds);
    setBulkSummary({ succeeded: succeededIds.length, failed: failedIds.length, skipped });
    setBulkReview(null);
    setPendingKey(null);
  };

  const resolveConflict = async (
    action: 'keep_left' | 'keep_right' | 'keep_both',
  ) => {
    if (!conflictPair || !conflictReason.trim()) return;
    const succeeded = await runMutation(
      `resolve:${conflictPair.memory.id}:${conflictPair.counterpart.id}`,
      () => personasService.resolveMemoryConflict(
        detail.persona.id,
        conflictPair.memory.id,
        {
          counterpartId: conflictPair.counterpart.id,
          action,
          reason: conflictReason.trim(),
          resolutionId: `memory_resolution_${uuidv4().replaceAll('-', '')}`,
        },
      ),
    );
    if (succeeded) {
      setConflictPair(null);
      setConflictReason('');
    }
  };

  const safeConflictCounterparts = (memory: MemoryItem): MemoryItem[] => (
    FEATURES.ENABLE_MEMORY_CONFLICT_SURFACING
      ? (memory.conflictsWith ?? [])
        .map(id => detailById.get(id))
        .filter((candidate): candidate is MemoryItem => (
          candidate !== undefined
          && candidate.id !== memory.id
          && candidate.personaId === memory.personaId
          && candidate.status !== 'superseded'
        ))
      : []
  );

  const openAdd = () => {
    setAddRequestId(`memory_${uuidv4().replaceAll('-', '')}`);
    setAddContent('');
    setAddValidFromDate('');
    setAddValidUntilDate('');
    setMemoryError(null);
    setAddOpen(true);
  };

  const submitAdd = async () => {
    const succeeded = await runMutation(
      'create',
      () => personasService.createMemory(detail.persona.id, {
        content: addContent.trim(),
        requestId: addRequestId,
        ...(addValidFrom !== undefined ? { validFrom: addValidFrom } : {}),
        ...(addValidUntil !== undefined ? { validUntil: addValidUntil } : {}),
      }),
    );
    if (succeeded) {
      setAddOpen(false);
      setAddContent('');
      setAddRequestId('');
      setAddValidFromDate('');
      setAddValidUntilDate('');
    }
  };

  const bucketLabel = (bucket: MemoryBucket) => {
    if (bucket === 'important') return t('personas.memory.important');
    if (bucket === 'remembered') return t('personas.memory.remembered');
    if (bucket === 'needsReview') return t('personas.memory.needsReview');
    return t('personas.memory.forgotten');
  };
  const bucketItems = (bucket: MemoryBucket) => memories.filter((memory) => {
    const core = optimistic[memory.id]?.core ?? coreIds.has(memory.id);
    return memoryBucket(memory, core) === bucket;
  });

  const hasAnyVisibleMemory = memories.length > 0;
  const noResults = normalizedQuery.length > 0 && !hasAnyVisibleMemory;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 3.5 }}>
      <Stack spacing={2.5}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          alignItems={{ xs: 'stretch', md: 'center' }}
        >
          <Stack direction="row" spacing={1} alignItems="center" flex={1}>
            <MemoryRounded color="primary" />
            <Typography variant="h5" fontWeight={780}>
              {t('personas.memory.title')}
            </Typography>
          </Stack>
          <TextField
            size="small"
            label={t('personas.memory.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button variant="contained" onClick={openAdd} disabled={isPending}>
            {t('personas.memory.add')}
          </Button>
        </Stack>

        {memoryError && (
          <Alert
            severity="error"
            onClose={() => setMemoryError(null)}
            action={(
              <Button color="inherit" size="small" onClick={() => void refresh()}>
                {t('personas.refresh')}
              </Button>
            )}
          >
            {memoryError.message}
          </Alert>
        )}

        {bulkReview && (
          <Box role="status" aria-live="polite">
            <Typography color="text.secondary" sx={{ mb: 0.75 }}>
              {t('personas.memory.bulkProgress', {
                completed: bulkReview.completed,
                total: bulkReview.total,
              })}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={(bulkReview.completed / bulkReview.total) * 100}
            />
          </Box>
        )}

        {bulkSummary && (
          <Alert
            severity={bulkSummary.failed > 0 ? 'warning' : 'success'}
            onClose={() => setBulkSummary(null)}
          >
            {t('personas.memory.bulkSummary', bulkSummary)}
          </Alert>
        )}

        {pendingKey && !bulkReview && (
          <Typography role="status" aria-live="polite" color="text.secondary">
            {t('personas.memory.saving')}
          </Typography>
        )}

        {!hasAnyVisibleMemory && (
          <Typography color="text.secondary">
            {noResults ? t('personas.memory.noResults') : t('personas.memory.empty')}
          </Typography>
        )}

        {hasAnyVisibleMemory && (
          <Stack spacing={3}>
            {BUCKETS.map((bucket) => {
              const items = bucketItems(bucket);
              return (
                <Box component="section" key={bucket} aria-labelledby={`memory-${bucket}`}>
                  <Typography
                    id={`memory-${bucket}`}
                    variant="overline"
                    color="text.secondary"
                    fontWeight={800}
                  >
                    {bucketLabel(bucket)} · {items.length}
                  </Typography>
                  {bucket === 'needsReview' && items.length > 0 && (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 0.75 }}>
                      <Button
                        size="small"
                        disabled={isPending}
                        onClick={() => setSelectedReviewIds(
                          selectedReviewIds.length === items.length ? [] : items.map(item => item.id),
                        )}
                      >
                        {selectedReviewIds.length === items.length
                          ? t('personas.memory.clearSelection')
                          : t('personas.memory.selectAll')}
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={isPending || selectedReviewIds.length === 0}
                        onClick={() => void runBulkReview('approve')}
                      >
                        {t('personas.memory.approveSelected', { count: selectedReviewIds.length })}
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        disabled={isPending || selectedReviewIds.length === 0}
                        onClick={() => void runBulkReview('forget')}
                      >
                        {t('personas.memory.forgetSelected', { count: selectedReviewIds.length })}
                      </Button>
                    </Stack>
                  )}
                  {items.length === 0 ? (
                    <Typography color="text.secondary" sx={{ mt: 0.5 }}>
                      {bucket === 'needsReview'
                        ? t('personas.memory.noReview')
                        : t('personas.memory.sectionEmpty')}
                    </Typography>
                  ) : (
                    <Stack spacing={1.25} sx={{ mt: 0.75 }}>
                      {items.map((memory) => {
                        const core = optimistic[memory.id]?.core ?? coreIds.has(memory.id);
                        const earlierVersions = earlierMemoryVersions(memory, detail.memoryItems);
                        const canPin = memory.status === 'active'
                          && (memory.trust === 'explicit_user' || memory.trust === 'verified_tool');
                        const disclosureId = `memory-provenance-${memory.id}`;
                        const disclosureOpen = provenanceOpen === memory.id;
                        const conflicts = safeConflictCounterparts(memory);
                        const expiry = memory.status === 'candidate'
                          ? expiryMessage(memory.expiresAt, Date.now())
                          : null;
                        return (
                          <Card
                            key={memory.id}
                            variant="outlined"
                            sx={{
                              borderRadius: 3,
                              ...(memory.status === 'candidate'
                                ? { borderColor: 'warning.main', bgcolor: 'action.hover' }
                                : {}),
                            }}
                          >
                            <CardContent>
                              <Stack
                                direction={{ xs: 'column', sm: 'row' }}
                                justifyContent="space-between"
                                alignItems={{ xs: 'flex-start', sm: 'flex-start' }}
                                gap={1}
                              >
                                <Stack direction="row" spacing={0.5} alignItems="flex-start" flex={1}>
                                  {memory.status === 'candidate' && (
                                    <Checkbox
                                      checked={selectedReviewIds.includes(memory.id)}
                                      disabled={isPending}
                                      inputProps={{
                                        'aria-label': t('personas.memory.selectCandidate', {
                                          memory: memory.content,
                                        }),
                                      }}
                                      onChange={(event) => setSelectedReviewIds(current => (
                                        event.target.checked
                                          ? [...new Set([...current, memory.id])]
                                          : current.filter(id => id !== memory.id)
                                      ))}
                                    />
                                  )}
                                  <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                    {memory.content}
                                  </Typography>
                                </Stack>
                                <Stack direction="row" spacing={0.75} flexWrap="wrap" justifyContent="flex-end">
                                  {conflicts.length > 0 && (
                                    <Chip
                                      size="small"
                                      color="warning"
                                      icon={<WarningAmberRounded />}
                                      label={t('personas.memory.conflicts', { count: conflicts.length })}
                                    />
                                  )}
                                  <Chip
                                    size="small"
                                    color={memory.status === 'candidate'
                                      ? 'warning'
                                      : core
                                        ? 'primary'
                                        : memory.status === 'forgotten'
                                          ? 'default'
                                          : 'success'}
                                    icon={core ? <PushPinRounded /> : undefined}
                                    label={bucketLabel(memoryBucket(memory, core) ?? 'remembered')}
                                  />
                                </Stack>
                              </Stack>
                              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                                {t(actorKey(memory))}
                              </Typography>
                              {expiry && (
                                <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
                                  {t(expiry.key, expiry.values)}
                                </Typography>
                              )}
                              {conflicts.length > 0 && (
                                <Stack spacing={0.75} sx={{ mt: 1 }}>
                                  {conflicts.map(counterpart => (
                                    <Stack
                                      key={counterpart.id}
                                      direction={{ xs: 'column', sm: 'row' }}
                                      spacing={1}
                                      alignItems={{ xs: 'flex-start', sm: 'center' }}
                                      sx={{ p: 1, borderRadius: 2, bgcolor: 'warning.light' }}
                                    >
                                      <Typography variant="body2" flex={1}>
                                        {t('personas.memory.conflictsWith', {
                                          content: counterpart.content,
                                        })}
                                      </Typography>
                                      <Button
                                        size="small"
                                        disabled={isPending}
                                        onClick={() => {
                                          setConflictPair({ memory, counterpart });
                                          setConflictReason('');
                                        }}
                                      >
                                        {t('personas.memory.resolveConflict')}
                                      </Button>
                                    </Stack>
                                  ))}
                                </Stack>
                              )}
                              {(memory.validFrom !== undefined || memory.validUntil !== undefined) && (
                                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                                  {memory.validFrom !== undefined && memory.validUntil !== undefined
                                    ? t('personas.memory.usefulRange', {
                                      from: formatDate(memory.validFrom, { dateStyle: 'medium' }),
                                      until: formatDate(memory.validUntil, { dateStyle: 'medium' }),
                                    })
                                    : memory.validFrom !== undefined
                                      ? t('personas.memory.usefulFromValue', {
                                        date: formatDate(memory.validFrom, { dateStyle: 'medium' }),
                                      })
                                      : t('personas.memory.usefulUntilValue', {
                                        date: formatDate(memory.validUntil!, { dateStyle: 'medium' }),
                                      })}
                                </Typography>
                              )}
                              <Button
                                size="small"
                                sx={{ mt: 0.5, px: 0 }}
                                aria-expanded={disclosureOpen}
                                aria-controls={disclosureId}
                                onClick={() => setProvenanceOpen(
                                  disclosureOpen ? null : memory.id,
                                )}
                              >
                                {t('personas.memory.provenance')}
                              </Button>
                              {earlierVersions.length > 0 && (
                                <Button
                                  size="small"
                                  startIcon={<HistoryRounded />}
                                  sx={{ mt: 0.5, ml: 1 }}
                                  aria-expanded={historyOpen === memory.id}
                                  aria-controls={`memory-history-${memory.id}`}
                                  onClick={() => setHistoryOpen(
                                    historyOpen === memory.id ? null : memory.id,
                                  )}
                                >
                                  {t('personas.memory.earlierVersions', {
                                    count: earlierVersions.length,
                                  })}
                                </Button>
                              )}
                              {disclosureOpen && (
                                <Box
                                  id={disclosureId}
                                  sx={{ mt: 1, p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}
                                >
                                  <Typography variant="body2">{t(actorKey(memory))}</Typography>
                                  <Typography variant="body2" color="text.secondary">
                                    {t('personas.memory.updated', {
                                      date: formatDate(memory.updatedAt, {
                                        dateStyle: 'medium',
                                        timeStyle: 'short',
                                      }),
                                    })}
                                  </Typography>
                                  {(memory.supersedes ?? []).length > 0 && (
                                    <Typography variant="body2" color="text.secondary">
                                      {t('personas.memory.correctionHistory')}
                                    </Typography>
                                  )}
                                </Box>
                              )}
                              {historyOpen === memory.id && earlierVersions.length > 0 && (
                                <Stack
                                  id={`memory-history-${memory.id}`}
                                  spacing={1}
                                  sx={{ mt: 1.25 }}
                                >
                                  <Typography variant="subtitle2">
                                    {t('personas.memory.earlierVersionsTitle')}
                                  </Typography>
                                  {earlierVersions.map((earlier) => (
                                    <Box
                                      key={earlier.id}
                                      sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}
                                    >
                                      <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                        {earlier.content}
                                      </Typography>
                                      <Typography variant="caption" color="text.secondary">
                                        {t('personas.memory.versionChanged', {
                                          date: formatDate(earlier.updatedAt, {
                                            dateStyle: 'medium',
                                            timeStyle: 'short',
                                          }),
                                        })}
                                      </Typography>
                                    </Box>
                                  ))}
                                </Stack>
                              )}
                            </CardContent>
                            <CardActions sx={{ flexWrap: 'wrap' }}>
                              {memory.status === 'candidate' && (
                                <Button
                                  disabled={isPending}
                                  onClick={() => void runMutation(
                                    `activate:${memory.id}`,
                                    () => personasService.activateMemory(
                                      detail.persona.id,
                                      memory.id,
                                    ),
                                    memory.id,
                                    { status: 'active' },
                                  )}
                                >
                                  {t('personas.memory.activate')}
                                </Button>
                              )}
                              {memory.status !== 'forgotten' && (
                                <Button
                                  startIcon={<EditRounded />}
                                  disabled={isPending}
                                  onClick={() => {
                                     setCorrection(memory);
                                     setCorrectionContent(memory.content);
                                     setCorrectionValidFromDate(dateInputValue(memory.validFrom));
                                     setCorrectionValidUntilDate(dateInputValue(memory.validUntil));
                                     setMemoryError(null);
                                  }}
                                >
                                  {t('personas.memory.correct')}
                                </Button>
                              )}
                              {memory.status !== 'forgotten' && (
                                <Button
                                  color="error"
                                  disabled={isPending}
                                  onClick={() => setForgetting(memory)}
                                >
                                  {t('personas.memory.forget')}
                                </Button>
                              )}
                              {canPin && (
                                <Button
                                  disabled={isPending}
                                  startIcon={<PushPinRounded />}
                                  onClick={() => void runMutation(
                                    `pin:${memory.id}`,
                                    () => personasService.pinMemory(
                                      detail.persona.id,
                                      memory.id,
                                      !core,
                                    ),
                                    memory.id,
                                    { core: !core },
                                  )}
                                >
                                  {core ? t('personas.memory.unpin') : t('personas.memory.pin')}
                                </Button>
                              )}
                            </CardActions>
                          </Card>
                        );
                      })}
                    </Stack>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}
      </Stack>

      <Dialog
        open={Boolean(conflictPair)}
        onClose={() => !isPending && setConflictPair(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('personas.memory.resolveConflictTitle')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography>{t('personas.memory.resolveConflictHelp')}</Typography>
            {conflictPair && (
              <>
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Typography variant="caption" color="text.secondary">
                    {t('personas.memory.thisMemory')}
                  </Typography>
                  <Typography>{conflictPair.memory.content}</Typography>
                </Box>
                <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Typography variant="caption" color="text.secondary">
                    {t('personas.memory.otherMemory')}
                  </Typography>
                  <Typography>{conflictPair.counterpart.content}</Typography>
                </Box>
              </>
            )}
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={2}
              label={t('personas.memory.resolutionReason')}
              value={conflictReason}
              onChange={event => setConflictReason(event.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap' }}>
          <Button onClick={() => setConflictPair(null)} disabled={isPending}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            disabled={isPending || !conflictReason.trim()}
            onClick={() => void resolveConflict('keep_both')}
          >
            {t('personas.memory.keepBoth')}
          </Button>
          <Button
            disabled={isPending || !conflictReason.trim()}
            onClick={() => void resolveConflict('keep_right')}
          >
            {t('personas.memory.keepOther')}
          </Button>
          <Button
            variant="contained"
            disabled={isPending || !conflictReason.trim()}
            onClick={() => void resolveConflict('keep_left')}
          >
            {t('personas.memory.keepThis')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={addOpen} onClose={() => !isPending && setAddOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('personas.memory.addTitle')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography color="text.secondary">{t('personas.memory.addHelp')}</Typography>
             <TextField
              autoFocus
              fullWidth
              multiline
              minRows={4}
              label={t('personas.memory.content')}
              value={addContent}
               onChange={(event) => setAddContent(event.target.value)}
             />
             <Typography variant="body2" color="text.secondary">
               {t('personas.memory.availabilityHelp')}
             </Typography>
             <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
               <TextField
                 fullWidth
                 type="date"
                 label={t('personas.memory.usefulFrom')}
                 value={addValidFromDate}
                 onChange={(event) => setAddValidFromDate(event.target.value)}
                 slotProps={{ inputLabel: { shrink: true } }}
               />
               <TextField
                 fullWidth
                 type="date"
                 label={t('personas.memory.usefulUntil')}
                 value={addValidUntilDate}
                 onChange={(event) => setAddValidUntilDate(event.target.value)}
                 slotProps={{ inputLabel: { shrink: true } }}
               />
             </Stack>
             {addRangeInvalid && (
               <Alert severity="error">{t('personas.memory.availabilityInvalid')}</Alert>
             )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)} disabled={isPending}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={isPending || !addContent.trim() || addRangeInvalid}
            onClick={() => void submitAdd()}
          >
            {t('personas.memory.add')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(correction)}
        onClose={() => !isPending && setCorrection(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t('personas.memory.correct')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Alert severity="info">{t('personas.memory.correctHelp')}</Alert>
             <TextField
              autoFocus
              fullWidth
              multiline
              minRows={5}
              label={t('personas.memory.content')}
              value={correctionContent}
               onChange={(event) => setCorrectionContent(event.target.value)}
             />
             <Typography variant="body2" color="text.secondary">
               {t('personas.memory.availabilityHelp')}
             </Typography>
             <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
               <TextField
                 fullWidth
                 type="date"
                 label={t('personas.memory.usefulFrom')}
                 value={correctionValidFromDate}
                 onChange={(event) => setCorrectionValidFromDate(event.target.value)}
                 slotProps={{ inputLabel: { shrink: true } }}
               />
               <TextField
                 fullWidth
                 type="date"
                 label={t('personas.memory.usefulUntil')}
                 value={correctionValidUntilDate}
                 onChange={(event) => setCorrectionValidUntilDate(event.target.value)}
                 slotProps={{ inputLabel: { shrink: true } }}
               />
             </Stack>
             {correctionRangeInvalid && (
               <Alert severity="error">{t('personas.memory.availabilityInvalid')}</Alert>
             )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCorrection(null)} disabled={isPending}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            variant="contained"
            disabled={isPending || !correctionContent.trim() || correctionRangeInvalid}
            onClick={() => {
              if (!correction) return;
              void runMutation(
                `correct:${correction.id}`,
                () => personasService.correctMemory(
                  detail.persona.id,
                   correction,
                   correctionContent.trim(),
                   {
                     validFrom: correctionValidFrom,
                     validUntil: correctionValidUntil,
                   },
                 ),
              ).then((succeeded) => {
                if (succeeded) setCorrection(null);
              });
            }}
          >
            {t('personas.action.save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(forgetting)} onClose={() => !isPending && setForgetting(null)}>
        <DialogTitle>{t('personas.memory.forgetTitle')}</DialogTitle>
        <DialogContent dividers>
          <Typography>{t('personas.memory.forgetBody')}</Typography>
          {forgetting && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography sx={{ whiteSpace: 'pre-wrap' }}>{forgetting.content}</Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForgetting(null)} disabled={isPending}>
            {t('personas.action.cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={isPending}
            onClick={() => {
              if (!forgetting) return;
              const memory = forgetting;
              void runMutation(
                `forget:${memory.id}`,
                () => personasService.forgetMemory(detail.persona.id, memory.id),
                memory.id,
                { status: 'forgotten', core: false },
              ).then((succeeded) => {
                if (succeeded) setForgetting(null);
              });
            }}
          >
            {t('personas.memory.forget')}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}
