'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { HarnessPolicySchema, type HarnessPolicy, type HarnessProfile, type HarnessTarget, type HarnessVersion } from '@/shared/types/harnessIntegration';

interface TargetOption { id: string; label: string; target: HarnessTarget; prompt: string; modelId?: string }
interface ProfileView extends Omit<HarnessProfile, 'versions'> {
  versions: Omit<HarnessVersion, 'flow'>[];
  queue: { pendingTasks: number; experimentId?: string; nextRunAt?: number };
}
export default function TargetVersions({ workspace, enabled, models, onSelect, onExperiment }: {
  workspace: string; enabled: boolean; models: Array<{ id: string; label: string }>;
  onSelect: (option: TargetOption | undefined) => void; onExperiment: (id: string) => void;
}) {
  const { t } = useI18n();
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [selected, setSelected] = useState('');
  const [policy, setPolicy] = useState<HarnessPolicy>(() => HarnessPolicySchema.parse({ modelId: 'select-model' }));
  const [policyRevision, setPolicyRevision] = useState<number>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [inspected, setInspected] = useState<string>();
  const profile = profiles.find(item => item.id === selected);
  const option = targets.find(item => item.id === selected);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(withWorkspaceUrl('/api/harness/profiles', workspace), { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load improvement targets.');
    setTargets(data.targets); setProfiles(data.profiles);
    return data as { targets: TargetOption[]; profiles: ProfileView[] };
  }, [workspace]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).then(data => {
      const query = new URLSearchParams(window.location.search);
      const match = data.targets.find(item => item.target.kind === 'flow'
        ? item.target.flowId === query.get('flowId')
        : item.target.personaId === query.get('personaId') && (!query.get('behaviorId') || item.target.behaviorId === query.get('behaviorId')));
      if (match) {
        setSelected(match.id);
        setPolicy(data.profiles.find(item => item.id === match.id)?.policy ?? HarnessPolicySchema.parse({ modelId: match.modelId ?? 'select-model' }));
        setPolicyRevision(data.profiles.find(item => item.id === match.id)?.updatedAt);
        onSelect(match);
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [refresh, onSelect]);
  async function mutate(body: unknown) {
    setBusy(true); setError('');
    try {
      const response = await fetch(withWorkspaceUrl('/api/harness/profiles', workspace), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Improvement settings could not be saved.');
      const updated = await refresh();
      const current = updated.profiles.find(item => item.id === selected);
      if (current) { setPolicy(current.policy); setPolicyRevision(current.updatedAt); }
      const target = updated.targets.find(item => item.id === selected);
      if (target) onSelect(target);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); }
    finally { setBusy(false); }
  }
  return <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
    <Stack spacing={2}>
      <Typography variant="h5" component="h2">{t('harness.versions')}</Typography>
      <Typography variant="body2">{t('harness.integrationHelp')}</Typography>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      <TextField select label={t('harness.target')} value={selected} disabled={busy} onChange={event => {
        const id = event.target.value, target = targets.find(item => item.id === id);
        setSelected(id); setInspected(undefined); onSelect(target);
        setPolicyRevision(profiles.find(item => item.id === id)?.updatedAt);
        setPolicy(profiles.find(item => item.id === id)?.policy ?? HarnessPolicySchema.parse({ modelId: target?.modelId ?? models[0]?.id ?? 'select-model' }));
      }}>
        <MenuItem value="">{t('harness.scratch')}</MenuItem>
        {targets.map(item => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
      </TextField>
      {option && <>
        <FormControlLabel label={t('harness.automatic')} control={<Switch disabled={busy || !enabled} checked={policy.automatic}
          onChange={event => setPolicy({ ...policy, automatic: event.target.checked })} />} />
        <Typography variant="body2" color="text.secondary">{t('harness.automaticHelp')}</Typography>
        <TextField select label={t('harness.model')} value={models.some(item => item.id === policy.modelId) ? policy.modelId : ''} disabled={busy}
          onChange={event => setPolicy({ ...policy, modelId: event.target.value })}>
          {models.map(item => <MenuItem key={item.id} value={item.id}>{item.label}</MenuItem>)}
        </TextField>
        <TextField label={t('harness.rubric')} multiline minRows={3} value={policy.rubric} disabled={busy}
          onChange={event => setPolicy({ ...policy, rubric: event.target.value })} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select fullWidth label={t('harness.rounds')} value={policy.rounds} disabled={busy} onChange={event => setPolicy({ ...policy, rounds: Number(event.target.value) })}>
            {[1, 2, 3].map(value => <MenuItem value={value} key={value}>{value}</MenuItem>)}
          </TextField>
          <TextField fullWidth type="number" label={t('harness.cooldown')} value={policy.cooldownMinutes} disabled={busy} onChange={event => setPolicy({ ...policy, cooldownMinutes: Number(event.target.value) })} />
          <TextField fullWidth type="number" label={t('harness.probeCalls')} value={policy.maxModelCallsPerProbe} disabled={busy}
            slotProps={{ htmlInput: { min: 1, max: 16 } }} onChange={event => setPolicy({ ...policy, maxModelCallsPerProbe: Number(event.target.value) })} />
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button variant="contained" disabled={busy || !enabled || (policy.automatic && !models.some(item => item.id === policy.modelId))} onClick={() => void mutate({ action: 'configure', target: option.target, policy, expectedUpdatedAt: policyRevision })}>{t('harness.save')}</Button>
          <Button disabled={busy} onClick={() => void refresh().then(data => {
            const current = data.profiles.find(item => item.id === selected);
            if (current) { setPolicy(current.policy); setPolicyRevision(current.updatedAt); }
          }).catch(cause => setError(cause.message))}>{t('harness.refresh')}</Button>
          {profile && <Chip color={profile.policy.automatic ? 'success' : 'default'} label={t(profile.policy.automatic ? 'harness.autoOn' : 'harness.autoOff')} />}
        </Stack>
        {profile && <>
          <Typography>{t('harness.queuedTasks')}: {profile.queue.pendingTasks} / 4</Typography>
          {profile.lastError && <Alert severity="warning">{profile.lastError}</Alert>}
          {(profile.runningExperimentId || profile.queue.experimentId) && <Button onClick={() => onExperiment(profile.runningExperimentId ?? profile.queue.experimentId!)}>{t('harness.evidence')}</Button>}
          <Typography variant="body2">{t('harness.activationHelp')}</Typography>
          {[...profile.versions].reverse().map((version, index) => <Box key={version.id} sx={{ border: 1, borderColor: 'divider', p: 2, borderRadius: 2 }}>
            <Stack spacing={1}>
              <Stack direction="row" useFlexGap spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography>v{profile.versions.length - index} · {version.label}</Typography>
                {version.id === profile.activeVersionId && <Chip size="small" color="success" label={t('harness.active')} />}
                <Button size="small" onClick={() => setInspected(inspected === version.id ? undefined : version.id)}>{t('harness.compare')}</Button>
                {version.experimentId && <Button size="small" onClick={() => onExperiment(version.experimentId!)}>{t('harness.evidence')}</Button>}
                {version.id !== profile.activeVersionId && <Button disabled={busy || !enabled} onClick={() => void mutate({ action: 'activate', profileId: profile.id, versionId: version.id, expectedUpdatedAt: profile.updatedAt })}>{t('harness.activate')}</Button>}
              </Stack>
              {inspected === version.id && <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                {[profile.versions.find(item => item.id === profile.activeVersionId), version].map((item, i) => <Box component="pre" key={i}
                  sx={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', bgcolor: 'action.hover', p: 2 }}>{item?.prompt}</Box>)}
              </Stack>}
            </Stack>
          </Box>)}
          {profile.events.slice(-8).reverse().map((event, index) => <Typography key={index} variant="body2" color="text.secondary">
            {new Date(event.at).toLocaleString()} · {event.detail}
          </Typography>)}
        </>}
      </>}
    </Stack>
  </Paper>;
}
