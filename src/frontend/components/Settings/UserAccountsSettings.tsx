'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import Link from 'next/link';
import { PASSWORD_MIN_LENGTH, type InstallationRole } from '@/shared/types/accounts';

interface Person {
  id: string;
  name: string;
  displayName: string;
  role: InstallationRole;
  hostAccess: boolean;
  disabled: boolean;
}

interface ApiToken {
  id: string;
  label?: string;
  expiresAt: number;
  revokedAt: number | null;
}

interface WorkspaceOwnerRow {
  name: string;
  ownerType: string | null;
  ownerId: string | null;
}

interface PeopleList {
  revision: number;
  me: string;
  users: Person[];
  workspaces: WorkspaceOwnerRow[];
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | {
    kind: 'ready';
    mode: 'off' | 'on' | 'damaged';
    user: Person | null;
    tokens: ApiToken[];
    people: PeopleList | null;
    loadedAt: number;
    problem: string | null;
  };

interface ApiResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  error: string;
  code: string | null;
}

type Notice = { severity: 'error' | 'success'; text: string };

const UNREACHABLE = 'Could not reach FLUJO. Check that it is still running, then try again.';
const DAMAGED = 'Sign-in is unavailable because the accounts file on the server is damaged. An admin must fix that file on the server.';
const HOST_ACCESS_WARNING = 'Host access lets a person run programs and read every file on the server. Give it only to people you fully trust. Admins always have it.';

async function callApi(url: string, method: string, body: unknown, signal: AbortSignal): Promise<ApiResult> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object') parsed = { ...value };
  } catch {
    parsed = {};
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    error: typeof parsed.error === 'string' && parsed.error ? parsed.error : 'Something went wrong. Try again.',
    code: typeof parsed.code === 'string' ? parsed.code : null,
  };
}

function isPerson(value: unknown): value is Person {
  if (!value || typeof value !== 'object') return false;
  const person = { ...value } as Partial<Record<keyof Person, unknown>>;
  return typeof person.id === 'string' && typeof person.name === 'string' && typeof person.displayName === 'string'
    && (person.role === 'admin' || person.role === 'member') && typeof person.hostAccess === 'boolean'
    && typeof person.disabled === 'boolean';
}

function isApiToken(value: unknown): value is ApiToken {
  if (!value || typeof value !== 'object') return false;
  const token = { ...value } as Partial<Record<keyof ApiToken, unknown>>;
  return typeof token.id === 'string' && typeof token.expiresAt === 'number'
    && (token.revokedAt === null || typeof token.revokedAt === 'number')
    && (token.label === undefined || typeof token.label === 'string');
}

function isPeopleList(value: Record<string, unknown>): value is Record<string, unknown> & PeopleList {
  return typeof value.revision === 'number' && typeof value.me === 'string'
    && Array.isArray(value.users) && value.users.every(isPerson) && Array.isArray(value.workspaces);
}

async function loadAccounts(signal: AbortSignal): Promise<Loaded> {
  const session = await callApi('/api/accounts/session', 'GET', undefined, signal);
  const loadedAt = Date.now();
  if (session.code === 'ACCOUNTS_DAMAGED' || session.body.mode === 'damaged') {
    return { kind: 'ready', mode: 'damaged', user: null, tokens: [], people: null, loadedAt, problem: null };
  }
  if (!session.ok) return { kind: 'failed', message: session.error };
  if (session.body.mode !== 'on') {
    return { kind: 'ready', mode: 'off', user: null, tokens: [], people: null, loadedAt, problem: null };
  }
  const user = isPerson(session.body.user) ? session.body.user : null;
  if (!user) return { kind: 'ready', mode: 'on', user: null, tokens: [], people: null, loadedAt, problem: null };
  const [tokens, people] = await Promise.all([
    callApi('/api/accounts/tokens', 'GET', undefined, signal),
    user.role === 'admin' ? callApi('/api/accounts/users', 'GET', undefined, signal) : Promise.resolve(null),
  ]);
  const problems = [tokens, people].filter((result): result is ApiResult => result !== null && !result.ok);
  return {
    kind: 'ready',
    mode: 'on',
    user,
    tokens: tokens.ok && Array.isArray(tokens.body.tokens) ? tokens.body.tokens.filter(isApiToken) : [],
    people: people?.ok && isPeopleList(people.body) ? people.body : null,
    loadedAt,
    problem: problems[0]?.error ?? null,
  };
}

/** One request at a time per panel, with its own busy flag and message. Requests stop when the panel goes away. */
function useAccountRequest() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const send = useCallback(async (url: string, method: string, body?: unknown): Promise<ApiResult | null> => {
    if (active.current) return null;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice(null);
    try {
      const result = await callApi(url, method, body, controller.signal);
      if (controller.signal.aborted) return null;
      if (!result.ok) setNotice({ severity: 'error', text: result.error });
      return result;
    } catch {
      if (!controller.signal.aborted) setNotice({ severity: 'error', text: UNREACHABLE });
      return null;
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  return { busy, notice, setNotice, send };
}

function NoticeAlert({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return <Alert severity={notice.severity} role={notice.severity === 'error' ? 'alert' : 'status'}>{notice.text}</Alert>;
}

function TurnOnForm({ reloadPage }: { reloadPage: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setNotice({ severity: 'error', text: `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.` });
      return;
    }
    if (password !== repeat) {
      setNotice({ severity: 'error', text: 'The two passwords are not the same.' });
      return;
    }
    const result = await send('/api/accounts/mode', 'POST', {
      enabled: true,
      name: name.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      password,
    });
    if (result?.ok) reloadPage();
  };

  return (
    <Stack spacing={2}>
      <Typography>
        Let several people use this FLUJO, each with their own private workspaces. Everyone signs in with a name and
        password. Admins can see everything.
      </Typography>
      <Alert severity="warning">
        After you turn this on, everyone must sign in to use FLUJO, including you. All workspaces that exist now will
        belong to you, the first admin. You can turn it off again here; nothing is deleted.
      </Alert>
      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 480 }}>
        <TextField label="Your sign-in name" value={name} disabled={busy} autoComplete="username"
          helperText="Lower-case letters, digits, dots, dashes or underscores."
          onChange={event => setName(event.target.value)} />
        <TextField label="Display name" value={displayName} disabled={busy} helperText="Optional. Shown to other people."
          onChange={event => setDisplayName(event.target.value)} />
        <TextField label="Password" type="password" value={password} disabled={busy} autoComplete="new-password"
          helperText={`At least ${PASSWORD_MIN_LENGTH} characters.`} onChange={event => setPassword(event.target.value)} />
        <TextField label="Repeat password" type="password" value={repeat} disabled={busy} autoComplete="new-password"
          onChange={event => setRepeat(event.target.value)} />
        <Box>
          <Button type="submit" variant="contained" disabled={busy}>Turn on sign-in for several people</Button>
        </Box>
      </Box>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function SignedInPanel({ user }: { user: Person }) {
  const { busy, notice, send } = useAccountRequest();
  const signOut = async () => {
    const result = await send('/api/accounts/session', 'DELETE');
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full page load drops everything the signed-out person loaded in this tab
    if (result?.ok) window.location.assign('/owner/login');
  };
  return (
    <Stack spacing={1.5}>
      <Typography>
        Signed in as <strong>{user.displayName}</strong>{user.role === 'admin' ? ' (admin)' : ''}.
      </Typography>
      <Box>
        <Button variant="outlined" disabled={busy} onClick={() => void signOut()}>Sign out</Button>
      </Box>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function TokensPanel({ tokens, loadedAt, reload }: { tokens: ApiToken[]; loadedAt: number; reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const shown = tokens.filter(token => token.revokedAt === null);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await send('/api/accounts/tokens', 'POST', label.trim() ? { label: label.trim() } : {});
    if (!result?.ok) return;
    setNewToken(typeof result.body.token === 'string' ? result.body.token : null);
    setLabel('');
    reload();
  };
  const revoke = async (token: ApiToken) => {
    const result = await send('/api/accounts/tokens', 'DELETE', { id: token.id });
    if (!result?.ok) return;
    setNotice({ severity: 'success', text: `Revoked ${token.label ?? 'the token'}.` });
    reload();
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Your API tokens</Typography>
      <Typography variant="body2" color="text.secondary">
        Programs and scripts can use an API token to act as you. Treat a token like a password.
      </Typography>
      {shown.length === 0
        ? <Typography variant="body2">You have no API tokens.</Typography>
        : (
          <Stack component="ul" spacing={1} sx={{ listStyle: 'none', p: 0, m: 0 }}>
            {shown.map(token => {
              const expired = token.expiresAt <= loadedAt;
              return (
                <Box component="li" key={token.id} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                  <Typography sx={{ fontWeight: 600 }}>{token.label ?? 'Token without a label'}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {expired ? 'Expired on' : 'Expires on'} {new Date(token.expiresAt).toLocaleDateString()}
                  </Typography>
                  <Button size="small" color="error" variant="outlined" disabled={busy}
                    aria-label={`Revoke ${token.label ?? 'token without a label'}`} onClick={() => void revoke(token)}>
                    Revoke
                  </Button>
                </Box>
              );
            })}
          </Stack>
        )}
      {newToken && (
        <Alert severity="success" role="status">
          <Stack spacing={1}>
            <span>Copy this token now. It is not shown again.</span>
            <TextField label="New token" value={newToken} size="small" slotProps={{ htmlInput: { readOnly: true } }}
              onFocus={event => event.target.select()} />
            <Box><Button size="small" onClick={() => setNewToken(null)}>Done</Button></Box>
          </Stack>
        </Alert>
      )}
      <Box component="form" onSubmit={create} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField label="Token label" size="small" value={label} disabled={busy} onChange={event => setLabel(event.target.value)} />
        <Button type="submit" variant="outlined" disabled={busy}>Create token</Button>
      </Box>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function PeoplePanel({ people, reload }: { people: PeopleList; reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const change = async (person: Person, patch: Record<string, unknown>, done: string) => {
    const result = await send('/api/accounts/users', 'PATCH', { id: person.id, ...patch, expectedRevision: people.revision });
    if (result?.code === 'ACCOUNTS_CHANGED') {
      setNotice({ severity: 'error', text: 'Someone else changed the people list just now. It is up to date again; try once more.' });
      reload();
      return false;
    }
    if (!result?.ok) return false;
    setNotice({ severity: 'success', text: done });
    reload();
    return true;
  };
  const savePassword = async (event: FormEvent<HTMLFormElement>, person: Person) => {
    event.preventDefault();
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setNotice({ severity: 'error', text: `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.` });
      return;
    }
    if (await change(person, { password: newPassword }, `Saved a new password for ${person.displayName}.`)) {
      setPasswordFor(null);
      setNewPassword('');
    }
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">People</Typography>
      <Alert severity="warning">{HOST_ACCESS_WARNING}</Alert>
      <TableContainer>
        <Table size="small" aria-label="People">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Display name</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Host access</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {people.users.map(person => (
              <TableRow key={person.id}>
                <TableCell>{person.name}{person.id === people.me ? ' (you)' : ''}</TableCell>
                <TableCell>{person.displayName}</TableCell>
                <TableCell>{person.role === 'admin' ? 'Admin' : 'Member'}</TableCell>
                <TableCell>{person.hostAccess ? 'Yes' : 'No'}</TableCell>
                <TableCell>{person.disabled ? 'Turned off' : 'Active'}</TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button size="small" disabled={busy} onClick={() => void change(person, { disabled: !person.disabled },
                      person.disabled ? `Turned on ${person.displayName}.` : `Turned off ${person.displayName}.`)}>
                      {person.disabled ? 'Turn on' : 'Turn off'}
                    </Button>
                    <Button size="small" disabled={busy} onClick={() => void change(person,
                      { role: person.role === 'admin' ? 'member' : 'admin' },
                      person.role === 'admin' ? `${person.displayName} is now a member.` : `${person.displayName} is now an admin.`)}>
                      {person.role === 'admin' ? 'Make member' : 'Make admin'}
                    </Button>
                    {person.role === 'member' && (
                      <Button size="small" disabled={busy} color={person.hostAccess ? 'primary' : 'warning'}
                        onClick={() => void change(person, { hostAccess: !person.hostAccess },
                          person.hostAccess ? `Removed host access for ${person.displayName}.` : `Allowed host access for ${person.displayName}.`)}>
                        {person.hostAccess ? 'Remove host access' : 'Allow host access'}
                      </Button>
                    )}
                    <Button size="small" disabled={busy} onClick={() => { setPasswordFor(person.id); setNewPassword(''); }}>
                      Set new password
                    </Button>
                  </Box>
                  {passwordFor === person.id && (
                    <Box component="form" onSubmit={event => void savePassword(event, person)}
                      sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <TextField label={`New password for ${person.name}`} type="password" size="small" autoComplete="new-password"
                        value={newPassword} disabled={busy} helperText={`At least ${PASSWORD_MIN_LENGTH} characters.`}
                        onChange={event => setNewPassword(event.target.value)} />
                      <Button type="submit" size="small" variant="contained" disabled={busy}>Save password</Button>
                      <Button size="small" disabled={busy} onClick={() => { setPasswordFor(null); setNewPassword(''); }}>Cancel</Button>
                    </Box>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function AddPersonForm({ reload }: { reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<InstallationRole>('member');
  const [hostAccess, setHostAccess] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      setNotice({ severity: 'error', text: `Use a password of at least ${PASSWORD_MIN_LENGTH} characters.` });
      return;
    }
    const result = await send('/api/accounts/users', 'POST', {
      name: name.trim(),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      password,
      role,
      hostAccess: role === 'member' && hostAccess,
    });
    if (!result?.ok) return;
    setNotice({ severity: 'success', text: `Added ${name.trim()}. They can sign in now.` });
    setName(''); setDisplayName(''); setPassword(''); setRole('member'); setHostAccess(false);
    reload();
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Add a person</Typography>
      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 480 }}>
        <TextField label="Sign-in name" value={name} disabled={busy} autoComplete="off"
          helperText="Lower-case letters, digits, dots, dashes or underscores."
          onChange={event => setName(event.target.value)} />
        <TextField label="Display name" value={displayName} disabled={busy} helperText="Optional."
          onChange={event => setDisplayName(event.target.value)} />
        <TextField label="Password" type="password" value={password} disabled={busy} autoComplete="new-password"
          helperText={`At least ${PASSWORD_MIN_LENGTH} characters. Tell it to the person privately.`}
          onChange={event => setPassword(event.target.value)} />
        <TextField select label="Role" value={role} disabled={busy} slotProps={{ select: { native: true } }}
          onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'member')}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </TextField>
        {role === 'member' && (
          <FormControlLabel
            control={<Checkbox checked={hostAccess} disabled={busy} onChange={event => setHostAccess(event.target.checked)} />}
            label="Host access (can run programs and read every file on the server)"
          />
        )}
        <Box>
          <Button type="submit" variant="contained" disabled={busy}>Add person</Button>
        </Box>
      </Box>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function WorkspaceOwnersPanel({ people, reload }: { people: PeopleList; reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const nameOf = (id: string | null) => {
    const person = people.users.find(candidate => candidate.id === id);
    return person ? `${person.displayName} (${person.name})` : 'Someone who no longer exists';
  };
  const ownerText = (workspace: WorkspaceOwnerRow) => workspace.ownerType === 'user'
    ? nameOf(workspace.ownerId)
    : workspace.ownerType === null ? 'Unassigned (admins only)' : 'A team';
  const chosen = (workspace: WorkspaceOwnerRow) => choice[workspace.name]
    ?? (workspace.ownerType === 'user' && workspace.ownerId ? workspace.ownerId : people.users[0]?.id ?? '');

  const give = async (workspace: WorkspaceOwnerRow) => {
    const ownerId = chosen(workspace);
    if (!ownerId) return;
    const result = await send('/api/accounts/users', 'PUT', { workspace: workspace.name, ownerId });
    if (!result?.ok) return;
    setNotice({ severity: 'success', text: `${workspace.name} now belongs to ${nameOf(ownerId)}.` });
    reload();
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Workspaces</Typography>
      <Typography variant="body2" color="text.secondary">
        Each workspace belongs to one person. Only that person and admins can open it.
      </Typography>
      <TableContainer>
        <Table size="small" aria-label="Workspaces">
          <TableHead>
            <TableRow>
              <TableCell>Workspace</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell>Give it to someone else</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {people.workspaces.map(workspace => (
              <TableRow key={workspace.name}>
                <TableCell>{workspace.name}</TableCell>
                <TableCell>{ownerText(workspace)}</TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <TextField select size="small" label={`New owner of ${workspace.name}`} value={chosen(workspace)}
                      disabled={busy} slotProps={{ select: { native: true } }}
                      onChange={event => setChoice(current => ({ ...current, [workspace.name]: event.target.value }))}>
                      {people.users.map(person => (
                        <option key={person.id} value={person.id}>
                          {person.displayName} ({person.name}){person.disabled ? ', turned off' : ''}
                        </option>
                      ))}
                    </TextField>
                    <Button size="small" variant="outlined" disabled={busy || !chosen(workspace)}
                      onClick={() => void give(workspace)}>
                      Give to
                    </Button>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function TurnOffPanel({ reloadPage }: { reloadPage: () => void }) {
  const { busy, notice, send } = useAccountRequest();
  const [confirming, setConfirming] = useState(false);
  const turnOff = async () => {
    const result = await send('/api/accounts/mode', 'POST', { enabled: false });
    if (result?.ok) reloadPage();
  };
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Turn off sign-in</Typography>
      {confirming
        ? (
          <Alert severity="warning">
            <Stack spacing={1}>
              <span>
                Nothing is deleted. Everyone is signed out, and FLUJO works without sign-in again, as before. People and
                workspace owners are kept in case you turn it on again.
              </span>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Button color="warning" variant="contained" disabled={busy} onClick={() => void turnOff()}>Yes, turn it off</Button>
                <Button disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
              </Box>
            </Stack>
          </Alert>
        )
        : (
          <Box>
            <Button color="warning" variant="outlined" onClick={() => setConfirming(true)}>
              Turn off sign-in for several people
            </Button>
          </Box>
        )}
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function reloadWholePage() {
  window.location.reload();
}

/**
 * Settings → Users and sign-in: turn multi-user mode on, manage people,
 * workspace owners and API tokens (#574). Turning the mode on or off reloads
 * the page so every part of the app checks sign-in again.
 */
export default function UserAccountsSettings({ reloadPage = reloadWholePage }: { reloadPage?: () => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const reload = useCallback(() => setReloadKey(key => key + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    loadAccounts(controller.signal)
      .then(result => { if (!controller.signal.aborted) setLoaded(result); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ kind: 'failed', message: UNREACHABLE }); });
    return () => controller.abort();
  }, [reloadKey]);

  if (loaded.kind === 'loading') return <Typography role="status">Loading…</Typography>;
  if (loaded.kind === 'failed') {
    return (
      <Stack spacing={1.5}>
        <Alert severity="error">{loaded.message}</Alert>
        <Box><Button variant="outlined" onClick={reload}>Try again</Button></Box>
      </Stack>
    );
  }
  if (loaded.mode === 'damaged') return <Alert severity="error">{DAMAGED}</Alert>;
  if (loaded.mode === 'off') return <TurnOnForm reloadPage={reloadPage} />;
  if (!loaded.user) {
    return (
      <Alert severity="info">
        Sign-in for several people is on. <Link href="/owner/login?returnTo=%2Fsettings">Sign in</Link> to manage it.
      </Alert>
    );
  }
  return (
    <Stack spacing={4}>
      <SignedInPanel user={loaded.user} />
      {loaded.problem && <Alert severity="error">{loaded.problem}</Alert>}
      <TokensPanel tokens={loaded.tokens} loadedAt={loaded.loadedAt} reload={reload} />
      {loaded.people && (
        <>
          <PeoplePanel people={loaded.people} reload={reload} />
          <AddPersonForm reload={reload} />
          <WorkspaceOwnersPanel people={loaded.people} reload={reload} />
          <TurnOffPanel reloadPage={reloadPage} />
        </>
      )}
    </Stack>
  );
}
