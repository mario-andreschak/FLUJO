"use client";

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import { ENCRYPTION_LOCKED_EVENT } from '@/frontend/utils/encryptionLock';

type Inventory = { planToken: string; credentials: number; protection: 'passphrase' | 'operator-file'; retireActiveKey: boolean; activeKeyWillChange: boolean };
const stores = new Set(['models', 'mcp_servers', 'global_env_vars', 'registry_account']);
function inventory(value: unknown): Inventory {
  const data = value as { planToken?: unknown; protection?: unknown; stores?: unknown; retireActiveKey?: unknown; activeKeyWillChange?: unknown };
  if (!data || typeof data.planToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.planToken)
      || !['passphrase', 'operator-file'].includes(String(data.protection)) || !Array.isArray(data.stores)
      || typeof data.retireActiveKey !== 'boolean' || typeof data.activeKeyWillChange !== 'boolean') throw new Error();
  let credentials = 0;
  const seen = new Set<string>();
  for (const row of data.stores) {
    if (!row || !stores.has(row.store) || seen.has(row.store) || !Number.isSafeInteger(row.credentials) || row.credentials < 0) throw new Error();
    seen.add(row.store); credentials += row.credentials;
  }
  if (!Number.isSafeInteger(credentials)) throw new Error();
  return { planToken: data.planToken, credentials, protection: data.protection as Inventory['protection'],
    retireActiveKey: data.retireActiveKey, activeKeyWillChange: data.activeKeyWillChange };
}

export default function CredentialMigrationSettings() {
  const { t } = useI18n();
  const [workspace] = useState(getSelectedWorkspace);
  const [source, setSource] = useState('');
  const [recovery, setRecovery] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [operator, setOperator] = useState(false);
  const [retireActiveKey, setRetireActiveKey] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [plan, setPlan] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'failed' | 'done' | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; requestRef.current?.abort(); }, []);
  const invalidate = () => { setPlan(null); setConfirmed(false); setResult(null); };
  const clear = () => { setSource(''); setRecovery(''); setConfirmation(''); invalidate(); };
  const valid = recovery.length >= 16 && recovery.length <= 1024 && recovery === confirmation;
  const run = async (migrate: boolean) => {
    if (requestRef.current || !valid || (migrate && (!plan || !confirmed))) return;
    const request = new AbortController(); requestRef.current = request;
    const captured = generation.current;
    const current = () => captured === generation.current;
    let failed = false;
    setBusy(true); setResult(null);
    try {
      const response = await fetch(withWorkspaceUrl('/api/credential-migration', workspace), {
        method: 'POST', cache: 'no-store', signal: request.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: migrate ? 'migrate' : 'preflight', sourcePassphrase: source || undefined,
          recoveryPassphrase: recovery, protection: operator ? 'operator-file' : 'passphrase', retireActiveKey,
          ...(migrate ? { planToken: plan!.planToken, confirmMigration: true } : {}) }),
      });
      const data = await response.json();
      if (!current() || request.signal.aborted) return;
      if (!response.ok) throw new Error();
      if (migrate) {
        if (data.status !== 'committed') throw new Error();
        clear(); setResult('done');
      } else {
        const prepared = inventory(data);
        if (prepared.protection !== (operator ? 'operator-file' : 'passphrase') || prepared.retireActiveKey !== retireActiveKey
          || (retireActiveKey && !prepared.activeKeyWillChange)) throw new Error();
        setPlan(prepared); setConfirmed(false);
      }
    } catch {
      failed = true;
      if (current()) { clear(); setResult('failed'); }
    } finally {
      if (current()) {
        setBusy(false); requestRef.current = null;
        if (migrate) {
          setSource(''); setRecovery(''); setConfirmation(''); setPlan(null); setConfirmed(false);
          // Even a cancelled request may have committed a durable pending journal.
        }
        if (migrate || failed) window.dispatchEvent(new CustomEvent(ENCRYPTION_LOCKED_EVENT));
      }
    }
  };
  const cancel = () => { clear(); requestRef.current?.abort(); };
  return <Stack spacing={2} sx={{ mt: 3 }}>
    <Typography variant="h6">{t('settings.migration.title')}</Typography>
    <Alert severity="warning">{t('settings.migration.help')}</Alert>
    {result && <Alert severity={result === 'done' ? 'success' : 'error'}>{t(result === 'done' ? 'settings.migration.done' : 'settings.migration.failed')}</Alert>}
    <TextField type="password" autoComplete="current-password" disabled={busy} label={t('settings.migration.source')}
      value={source} onChange={event => { invalidate(); setSource(event.target.value); }} />
    <TextField type="password" autoComplete="new-password" disabled={busy} label={t('encryption.recovery.passphrase')}
      value={recovery} onChange={event => { invalidate(); setRecovery(event.target.value); }} />
    <TextField type="password" autoComplete="new-password" disabled={busy} label={t('settings.migration.confirmPassphrase')}
      value={confirmation} onChange={event => { invalidate(); setConfirmation(event.target.value); }} />
    <FormControlLabel control={<Checkbox checked={operator} disabled={busy} onChange={event => { invalidate(); setOperator(event.target.checked); }} />}
      label={t('settings.migration.operator')} />
    <FormControlLabel control={<Checkbox checked={retireActiveKey} disabled={busy} onChange={event => { invalidate(); setRetireActiveKey(event.target.checked); }} />}
      label={t('settings.migration.retireKey')} />
    <Button disabled={busy || !valid} onClick={() => void run(false)}>{t('settings.migration.preflight')}</Button>
    {plan && <>
      <Typography>{t('settings.migration.inventory', { count: plan.credentials })}</Typography>
      <Typography>{t(plan.activeKeyWillChange ? 'settings.migration.keyReplaced' : 'settings.migration.keyRetained')}</Typography>
      <FormControlLabel control={<Checkbox checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />}
        label={t('settings.migration.confirm')} />
      <Button disabled={busy || !confirmed || !valid} onClick={() => void run(true)}>{t('settings.migration.migrate')}</Button>
    </>}
    {busy && <Button onClick={cancel}>{t('encryption.recovery.cancel')}</Button>}
  </Stack>;
}
