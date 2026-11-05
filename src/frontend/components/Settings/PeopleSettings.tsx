'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, MenuItem,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';
import { ACCESS_ROLES, type AccessRole } from '@/shared/types/access';

interface AccessState {
  mode: 'off' | 'policy' | 'named';
  canManage?: boolean;
  canReadRecord?: boolean;
  recordWritable?: boolean;
}

interface Person {
  id: string;
  name: string;
  role: AccessRole | 'custom';
  workspaceId?: string;
  flowIds?: string[];
  expiresAt: number;
  status: 'active' | 'expired' | 'revoked';
  self: boolean;
}

interface RecordEntry {
  at: number;
  action: string;
  outcome: string;
  actor?: { name?: string; credentialId?: string; endUser?: string };
  target?: string;
  detail?: string;
}

const EXPIRY_DAYS = [30, 90, 365, 730] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_KEYS: Record<Person['status'], TranslationKey> = {
  active: 'settings.people.active', expired: 'settings.people.expired', revoked: 'settings.people.revoked',
};
const roleKey = (role: Person['role']) => `settings.people.role.${role}` as TranslationKey;

async function send(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method, credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

async function reasonOf(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = await response.json() as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : fallback;
  } catch { return fallback; }
}

/** People, roles and the record of who did what. The page never holds a secret after it is dismissed. */
export default function PeopleSettings() {
  const { t } = useI18n();
  const [access, setAccess] = useState<AccessState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<AccessRole>('operator');
  const [days, setDays] = useState<number>(365);
  const [workspaceId, setWorkspaceId] = useState('');
  const [flowIds, setFlowIds] = useState('');
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<{ kind: 'revoke' | 'expire'; person: Person } | null>(null);
  const [renaming, setRenaming] = useState<{ person: Person; value: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/owner/access', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { setUnavailable(true); return; }
      const state = await response.json() as AccessState;
      setAccess(state);
      setUnavailable(false);
      if (state.mode !== 'named') return;
      if (state.canManage) {
        const listed = await fetch('/api/owner/people', { credentials: 'same-origin', cache: 'no-store' });
        if (listed.ok) setPeople((await listed.json() as { people: Person[] }).people);
      }
      if (state.canReadRecord) {
        const read = await fetch('/api/owner/audit?limit=50', { credentials: 'same-origin', cache: 'no-store' });
        if (read.ok) setRecord((await read.json() as { entries: RecordEntry[] }).entries);
      }
    } catch { setUnavailable(true); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const perform = async (work: () => Promise<Response>, onDone?: (response: Response) => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      const response = await work();
      if (!response.ok) { setError(await reasonOf(response, t('settings.people.failed'))); return; }
      await onDone?.(response);
      await refresh();
    } catch { setError(t('settings.people.failed')); }
    finally { setBusy(false); }
  };

  const create = () => perform(() => send('/api/owner/people', 'POST', {
    name, role, expiresAt: Date.now() + days * DAY_MS,
    ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
    ...(flowIds.trim() ? { flowIds: flowIds.split(',').map(value => value.trim()).filter(Boolean) } : {}),
  }), async response => {
    const created = await response.json() as { token: string };
    setSecret({ name, token: created.token });
    setCopied(false);
    setName('');
    setWorkspaceId('');
    setFlowIds('');
  });

  const copySecret = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.token); setCopied(true); }
    catch { setCopied(false); }
  };

  if (unavailable) return <Alert severity="warning">{t('settings.people.unavailable')}</Alert>;
  if (!access) return <Typography color="text.secondary">{t('settings.people.loading')}</Typography>;

  if (access.mode === 'off') {
    return <Stack spacing={2}>
      <Typography variant="subtitle1" fontWeight={600}>{t('settings.people.offTitle')}</Typography>
      <Typography variant="body2">{t('settings.people.offBody')}</Typography>
      <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', overflowX: 'auto', fontSize: 13 }}>
        node scripts/owner-access.mjs enable &lt;new-private-folder&gt;
      </Box>
      <Typography variant="body2" color="text.secondary">{t('settings.people.offNext')}</Typography>
    </Stack>;
  }

  if (access.mode === 'policy') {
    return <Stack spacing={2} alignItems="flex-start">
      <Typography variant="subtitle1" fontWeight={600}>{t('settings.people.policyTitle')}</Typography>
      <Typography variant="body2">{t('settings.people.policyBody')}</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Button variant="contained" disabled={busy}
        onClick={() => perform(() => send('/api/owner/access', 'POST', { action: 'enable' }))}>
        {t('settings.people.turnOn')}
      </Button>
    </Stack>;
  }

  return <Stack spacing={3}>
    <Typography variant="body2" color="text.secondary">{t('settings.people.intro')}</Typography>
    {error && <Alert severity="error" role="alert">{error}</Alert>}

    {access.canManage && <>
      <Stack spacing={1.5} component="form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <Typography variant="subtitle1" fontWeight={600}>{t('settings.people.addTitle')}</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField size="small" required label={t('settings.people.name')} value={name}
            inputProps={{ maxLength: 80 }} onChange={event => setName(event.target.value)} sx={{ flex: 1 }} />
          <TextField size="small" select label={t('settings.people.validFor')} value={days}
            onChange={event => setDays(Number(event.target.value))} sx={{ minWidth: 140 }}>
            {EXPIRY_DAYS.map(value => <MenuItem key={value} value={value}>{t('settings.people.days', { count: value })}</MenuItem>)}
          </TextField>
        </Stack>
        <TextField size="small" select label={t('settings.people.role')} value={role}
          onChange={event => setRole(event.target.value as AccessRole)}>
          {ACCESS_ROLES.map(value => <MenuItem key={value} value={value}>{t(roleKey(value))}</MenuItem>)}
        </TextField>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField size="small" label={t('settings.people.workspace')} value={workspaceId}
            onChange={event => setWorkspaceId(event.target.value)} sx={{ flex: 1 }} />
          <TextField size="small" label={t('settings.people.flows')} value={flowIds} helperText={t('settings.people.flowsHint')}
            onChange={event => setFlowIds(event.target.value)} sx={{ flex: 1 }} />
        </Stack>
        <Box>
          <Button type="submit" variant="contained" disabled={busy || !name.trim()}>{t('settings.people.create')}</Button>
        </Box>
      </Stack>

      <TableContainer>
        <Table size="small" aria-label={t('settings.section.people')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('settings.people.name')}</TableCell>
              <TableCell>{t('settings.people.role')}</TableCell>
              <TableCell>{t('settings.people.status')}</TableCell>
              <TableCell>{t('settings.people.expires')}</TableCell>
              <TableCell>{t('settings.people.limits')}</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {people.map(person => <TableRow key={person.id}>
              <TableCell>
                {person.name}
                {person.self && <Chip size="small" label={t('settings.people.you')} sx={{ ml: 1 }} />}
              </TableCell>
              <TableCell>{t(roleKey(person.role)).split(':')[0]}</TableCell>
              <TableCell>{t(STATUS_KEYS[person.status])}</TableCell>
              <TableCell>{new Date(person.expiresAt).toLocaleDateString()}</TableCell>
              <TableCell>
                {[person.workspaceId, ...(person.flowIds ?? [])].filter(Boolean).join(', ') || t('settings.people.none')}
              </TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                <Button size="small" disabled={busy} onClick={() => setRenaming({ person, value: person.name })}>{t('settings.people.rename')}</Button>
                <Button size="small" disabled={busy || person.status !== 'active'} onClick={() => setConfirming({ kind: 'expire', person })}>{t('settings.people.expireNow')}</Button>
                <Button size="small" color="error" disabled={busy || person.status === 'revoked'} onClick={() => setConfirming({ kind: 'revoke', person })}>{t('settings.people.revoke')}</Button>
              </TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </TableContainer>
    </>}

    {access.canReadRecord && <Stack spacing={1}>
      <Typography variant="subtitle1" fontWeight={600}>{t('settings.people.recordTitle')}</Typography>
      <Typography variant="body2" color="text.secondary">{t('settings.people.recordHint')}</Typography>
      {access.recordWritable === false && <Alert severity="warning">{t('settings.people.recordFailing')}</Alert>}
      {record.length === 0 ? <Typography variant="body2">{t('settings.people.recordEmpty')}</Typography> : <TableContainer>
        <Table size="small" aria-label={t('settings.people.recordTitle')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('settings.people.when')}</TableCell>
              <TableCell>{t('settings.people.action')}</TableCell>
              <TableCell>{t('settings.people.who')}</TableCell>
              <TableCell>{t('settings.people.target')}</TableCell>
              <TableCell>{t('settings.people.outcome')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {record.map(entry => <TableRow key={`${entry.at}-${entry.action}-${entry.target ?? ''}`}>
              <TableCell>{new Date(entry.at).toLocaleString()}</TableCell>
              <TableCell>{entry.action}{entry.detail ? ` (${entry.detail})` : ''}</TableCell>
              <TableCell>{[entry.actor?.name ?? entry.actor?.credentialId?.slice(0, 8), entry.actor?.endUser].filter(Boolean).join(' / ')}</TableCell>
              <TableCell>{entry.target?.slice(0, 16)}</TableCell>
              <TableCell>{entry.outcome}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </TableContainer>}
    </Stack>}

    <Dialog open={Boolean(secret)} aria-labelledby="people-secret-title">
      <DialogTitle id="people-secret-title">{t('settings.people.secretTitle')}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>{t('settings.people.secretBody')}</DialogContentText>
        <TextField fullWidth size="small" label={secret?.name} value={secret?.token ?? ''} slotProps={{ input: { readOnly: true } }}
          onFocus={event => event.target.select()} autoComplete="off" />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void copySecret()}>{copied ? t('settings.people.copied') : t('settings.people.copy')}</Button>
        <Button variant="contained" onClick={() => setSecret(null)}>{t('settings.people.done')}</Button>
      </DialogActions>
    </Dialog>

    <Dialog open={Boolean(confirming)} onClose={() => setConfirming(null)}>
      <DialogContent>
        <DialogContentText>
          {confirming && t(confirming.kind === 'revoke' ? 'settings.people.confirmRevoke' : 'settings.people.confirmExpire', { name: confirming.person.name })}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirming(null)}>{t('settings.people.cancel')}</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={() => {
          const current = confirming;
          setConfirming(null);
          if (!current) return;
          const url = `/api/owner/people/${encodeURIComponent(current.person.id)}`;
          void perform(() => current.kind === 'revoke' ? send(url, 'DELETE') : send(url, 'PATCH', { expiresAt: Date.now() }));
        }}>{t('settings.people.confirm')}</Button>
      </DialogActions>
    </Dialog>

    <Dialog open={Boolean(renaming)} onClose={() => setRenaming(null)}>
      <DialogTitle>{t('settings.people.renameTitle')}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth size="small" sx={{ mt: 1 }} value={renaming?.value ?? ''} inputProps={{ maxLength: 80 }}
          onChange={event => setRenaming(current => current && { ...current, value: event.target.value })} />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setRenaming(null)}>{t('settings.people.cancel')}</Button>
        <Button variant="contained" disabled={busy || !renaming?.value.trim()} onClick={() => {
          const current = renaming;
          setRenaming(null);
          if (!current) return;
          void perform(() => send(`/api/owner/people/${encodeURIComponent(current.person.id)}`, 'PATCH', { name: current.value }));
        }}>{t('settings.people.save')}</Button>
      </DialogActions>
    </Dialog>
  </Stack>;
}
