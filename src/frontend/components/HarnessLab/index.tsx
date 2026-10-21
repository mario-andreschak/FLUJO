'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, FormControlLabel, LinearProgress, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { ScienceRounded } from '@mui/icons-material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { HarnessInputSchema, harnessCallLimit, type HarnessCase, type HarnessRun } from '@/shared/types/harness';
import type { Flow } from '@/shared/types/flow';
import PageHeader from '@/frontend/components/shared/PageHeader';
import CaseEditor from './CaseEditor';
import RunEvidence from './RunEvidence';
import TargetVersions from './TargetVersions';
import { HarnessPolicySchema, type HarnessTarget } from '@/shared/types/harnessIntegration';

interface ModelOption { id: string; label: string; name: string; authentication: string }
interface RunSummary { id: string; name: string; status: HarnessRun['status']; createdAt: number }
const statusKeys = { pending: 'harness.pending', completed: 'harness.completed', failed: 'harness.failed', cancelled: 'harness.cancelled' } as const;
const initialCases: HarnessCase[] = [
  { id: 'train-1', split: 'train', input: 'Summarize this support request: My parcel arrived with a cracked lid. I need a replacement.', required: ['replacement', 'cracked'], forbidden: ['refund approved'] },
  { id: 'train-2', split: 'train', input: 'Summarize this support request: My invoice has the wrong address. Please correct it.', required: ['invoice', 'address'], forbidden: ['already corrected'] },
  { id: 'holdout-1', split: 'holdout', input: 'Summarize this support request: My headphones arrived without a charging cable. Please send the missing cable.', required: ['cable', 'missing'], forbidden: ['already shipped'] },
  { id: 'holdout-2', split: 'holdout', input: 'Summarize this support request: The tracking link is broken and I need a delivery update.', required: ['tracking', 'update'], forbidden: ['arrives tomorrow'] },
];

export default function HarnessLab() {
  const { t } = useI18n();
  const { settings, settingsHydrated } = useStorage();
  const enabled = settingsHydrated && settings.experimental?.harnessLabEnabled === true;
  const [workspace] = useState(getSelectedWorkspace);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<HarnessRun | null>(null);
  const [name, setName] = useState('Support summary');
  const [domain, setDomain] = useState('Customer support');
  const [modelId, setModelId] = useState('');
  const [basePrompt, setBasePrompt] = useState('Summarize the customer request in one short sentence. Preserve the reported problem and requested action. Do not claim that any action has been completed.');
  const [rounds, setRounds] = useState(1);
  const [reuseLessons, setReuseLessons] = useState(true);
  const [cases, setCases] = useState(initialCases);
  const [importStep, setImportStep] = useState('');
  const [target, setTarget] = useState<HarnessTarget>();
  const [rubric, setRubric] = useState('');
  const selectTarget = useCallback((option: { target: HarnessTarget; prompt: string; label: string; id: string; modelId?: string } | undefined) => {
    setTarget(option?.target);
    if (option) {
      setBasePrompt(option.prompt); setName(option.label.slice(0, 100)); setDomain(`target:${option.id}`);
      if (option.modelId) setModelId(option.modelId);
      setRubric(HarnessPolicySchema.parse({ modelId: option.modelId ?? 'select-model' }).rubric);
    }
  }, []);
  const controller = useRef<AbortController | null>(null);
  const pause = useRef(false);
  const createIdentity = useRef<{ id: string; payload: string } | null>(null);

  const api = useCallback(async <T,>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(withWorkspaceUrl(`/api/harness${path}`, workspace), {
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data as T;
  }, [workspace]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await api<{ models: ModelOption[]; runs: RunSummary[] }>('', undefined, signal);
    setModels(data.models); setHistory(data.runs);
    setModelId(current => current || data.models[0]?.id || '');
  }, [api]);

  useEffect(() => {
    const initial = new AbortController();
    void Promise.all([
      refresh(initial.signal),
      fetch(withWorkspaceUrl('/api/flow', workspace), { signal: initial.signal }).then(async response => {
        if (!response.ok) throw new Error(`Could not load agents (${response.status})`);
        setFlows(await response.json());
      }),
    ]).catch(cause => { if (!initial.signal.aborted) setError(String(cause.message)); })
      .finally(() => { if (!initial.signal.aborted) setLoading(false); });
    return () => { initial.abort(); pause.current = true; controller.current?.abort(); };
  }, [refresh, workspace]);

  async function execute(current: HarnessRun, signal: AbortSignal) {
    let next = current;
    while (next.status === 'pending' && !pause.current && !signal.aborted) {
      next = await api<HarnessRun>(`/${next.id}`, { action: 'advance' }, signal);
      setRun(next);
    }
    await refresh(signal);
  }

  async function perform(action: () => Promise<void>) {
    if (controller.current) return;
    const owned = new AbortController(); controller.current = owned;
    pause.current = false; setPausing(false); setBusy(true); setError('');
    try { await action(); }
    catch (cause) { if (!owned.signal.aborted) setError(cause instanceof Error ? cause.message : 'Request failed.'); }
    finally { if (controller.current === owned) controller.current = null; setBusy(false); setPausing(false); }
  }

  function create() {
    const parsed = HarnessInputSchema.safeParse({ name, domain, modelId, basePrompt, rounds, reuseLessons, target, rubric: rubric.trim() || undefined,
      cases: cases.map(item => ({ ...item, required: item.required.map(value => value.trim()).filter(Boolean), forbidden: item.forbidden.map(value => value.trim()).filter(Boolean) })),
    });
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(' ')); return; }
    const payload = JSON.stringify(parsed.data);
    if (createIdentity.current?.payload !== payload) createIdentity.current = { id: crypto.randomUUID(), payload };
    void perform(async () => {
      const created = await api<HarnessRun>('', { id: createIdentity.current!.id, input: parsed.data }, controller.current!.signal);
      setRun(created);
      await execute(created, controller.current!.signal);
    });
  }

  const importOptions = flows.flatMap(flow => flow.nodes.filter(node => node.type === 'process'
    && typeof node.data.properties?.promptTemplate === 'string').map(node => ({ value: `${flow.id}/${node.id}`, flow, node })));
  const callLimit = harnessCallLimit({ name, domain, modelId, basePrompt, rounds, reuseLessons, cases });

  return <Box sx={{ minHeight: '100%' }}>
    <PageHeader titleKey="harness.title" descriptionKey="harness.description" icon={ScienceRounded}
      badge={<Chip size="small" color="warning" label={t('harness.experimental')} />} />
    <Stack spacing={3} sx={{ p: { xs: 2, md: 3 }, maxWidth: 1250, mx: 'auto' }}>
      <Alert severity="info">{t('harness.scope')}</Alert>
      {!enabled && settingsHydrated && <Alert severity="info" action={<Button component="a" href={withWorkspaceUrl('/settings', workspace)}>{t('nav.settings')}</Button>}>{t('harness.off')}</Alert>}
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <TargetVersions workspace={workspace} enabled={enabled && !busy} models={models} onSelect={selectTarget}
        onExperiment={id => { void perform(async () => setRun(await api<HarnessRun>(`/${id}`, undefined, controller.current!.signal))); }} />
      {loading ? <CircularProgress aria-label={t('common.loading')} /> : <>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select fullWidth label={t('harness.history')} value={run?.id ?? ''} disabled={busy}
            onChange={event => { const id = event.target.value; if (!id) { setRun(null); return; } void perform(async () => setRun(await api<HarnessRun>(`/${id}`, undefined, controller.current!.signal))); }}>
            <MenuItem value="">—</MenuItem>
            {[...(run && !history.some(item => item.id === run.id) ? [{ id: run.id, name: run.input.name, status: run.status, createdAt: run.createdAt }] : []), ...history].map(item =>
              <MenuItem key={item.id} value={item.id}>{item.name} · {t(statusKeys[item.status])} · {new Date(item.createdAt).toLocaleString()}</MenuItem>)}
          </TextField>
          <Button disabled={busy} onClick={() => { setRun(null); setError(''); createIdentity.current = null; }}>{t('harness.new')}</Button>
        </Stack>
        {run ? <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
          <Stack spacing={3}>
            <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography component="h2" variant="h5">{run.input.name}</Typography><Chip label={t(statusKeys[run.status])} />
              {run.status === 'pending' && !busy && <Button variant="contained" disabled={!enabled} onClick={() => { void perform(() => execute(run, controller.current!.signal)); }}>{t('harness.continue')}</Button>}
              {busy && <Button disabled={pausing} onClick={() => { pause.current = true; setPausing(true); }}>{t(pausing ? 'harness.pausing' : 'harness.pause')}</Button>}
              {run.status === 'pending' && !busy && <Button onClick={() => { void perform(async () => { setRun(await api<HarnessRun>(`/${run.id}`, { action: 'cancel' }, controller.current!.signal)); await refresh(); }); }}>{t('common.cancel')}</Button>}
            </Stack>
            {busy && <LinearProgress aria-label={t('common.loading')} />}
            <RunEvidence run={run} busy={busy} enabled={enabled} workspace={workspace}
              onPromote={() => { void perform(async () => { setRun(await api<HarnessRun>(`/${run.id}`, { action: 'promote' }, controller.current!.signal)); await refresh(); }); }} />
          </Stack>
        </Paper> : <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
          <Stack spacing={3}>
            <Typography variant="h5" component="h2">{t('harness.new')}</Typography>
            {!models.length && <Alert severity="warning">{t('harness.noModels')}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField fullWidth label={t('harness.name')} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
              <TextField fullWidth label={t('harness.domain')} value={domain} disabled={busy} onChange={event => setDomain(event.target.value)} />
            </Stack>
            <TextField select label={t('harness.model')} value={modelId} disabled={busy || !models.length} onChange={event => setModelId(event.target.value)}>
              {models.map(model => <MenuItem value={model.id} key={model.id}>{model.label} · {model.authentication}</MenuItem>)}
            </TextField>
            {!target && importOptions.length > 0 && <TextField select label={t('harness.import')} value={importStep} disabled={busy}
              onChange={event => {
                setImportStep(event.target.value); const choice = importOptions.find(item => item.value === event.target.value);
                if (choice) { setBasePrompt(String(choice.node.data.properties?.promptTemplate)); setName(choice.flow.name);
                  const bound = choice.node.data.properties?.boundModel; if (models.some(model => model.id === bound)) setModelId(String(bound)); }
              }}>
              <MenuItem value="">—</MenuItem>{importOptions.map(choice => <MenuItem key={choice.value} value={choice.value}>{choice.flow.name} / {choice.node.data.label}</MenuItem>)}
            </TextField>}
            <TextField label={t('harness.prompt')} value={basePrompt} disabled={busy || Boolean(target)} fullWidth multiline minRows={5} onChange={event => setBasePrompt(event.target.value)} />
            <TextField label={t('harness.rubric')} value={rubric} disabled={busy} fullWidth multiline minRows={2} onChange={event => setRubric(event.target.value)} />
            <TextField select label={t('harness.rounds')} value={rounds} disabled={busy} onChange={event => setRounds(Number(event.target.value))}>
              {[1, 2, 3].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}
            </TextField>
            <FormControlLabel control={<Switch checked={reuseLessons} disabled={busy} onChange={event => setReuseLessons(event.target.checked)} />} label={t('harness.reuse')} />
            <CaseEditor cases={cases} disabled={busy} onChange={setCases} />
            <Alert severity="info">{t('harness.calls')}: {callLimit}. {t('harness.billing')}</Alert>
            <Button variant="contained" disabled={busy || !enabled || !modelId} onClick={create}>{t('harness.run')}</Button>
          </Stack>
        </Paper>}
      </>}
    </Stack>
  </Box>;
}
