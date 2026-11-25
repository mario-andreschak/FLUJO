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
import {
  PASSWORD_MIN_LENGTH, TEAM_ROLES, type InstallationRole, type TeamMemberState, type TeamRole,
} from '@/shared/types/accounts';

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

interface TeamName {
  id: string;
  name: string;
}

interface PeopleList {
  revision: number;
  me: string;
  users: Person[];
  /** Every team, so a workspace can be given to one (#575). */
  teams: TeamName[];
  workspaces: WorkspaceOwnerRow[];
}

interface TeamMemberRow {
  userId: string;
  name: string;
  displayName: string;
  role: TeamRole;
  state: TeamMemberState;
}

interface TeamRow {
  id: string;
  name: string;
  myRole: TeamRole | null;
  myState: TeamMemberState | null;
  mayManage: boolean;
  members: TeamMemberRow[];
  workspaces: string[];
}

interface TeamCandidate {
  id: string;
  name: string;
  displayName: string;
}

interface TeamsList {
  teams: TeamRow[];
  /** People a team owner or admin may add. Empty for everyone else. */
  people: TeamCandidate[];
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
    teams: TeamsList | null;
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
const TEAMS_CHANGED = 'Someone else changed the teams just now. They are up to date again; try once more.';

/** Team roles in plain words (#575). */
const TEAM_ROLE_WORDS: Readonly<Record<TeamRole, { label: string; help: string }>> = {
  owner: { label: 'Owner', help: 'can do everything, also manage the team' },
  member: { label: 'Member', help: 'can change and run things' },
  viewer: { label: 'Viewer', help: 'can only look' },
};

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

function isTeamName(value: unknown): value is TeamName {
  if (!value || typeof value !== 'object') return false;
  const team = { ...value } as Partial<Record<keyof TeamName, unknown>>;
  return typeof team.id === 'string' && typeof team.name === 'string';
}

function isPeopleList(value: Record<string, unknown>): value is Record<string, unknown> & PeopleList {
  return typeof value.revision === 'number' && typeof value.me === 'string'
    && Array.isArray(value.users) && value.users.every(isPerson) && Array.isArray(value.workspaces);
}

function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

function isTeamMemberRow(value: unknown): value is TeamMemberRow {
  if (!value || typeof value !== 'object') return false;
  const member = { ...value } as Partial<Record<keyof TeamMemberRow, unknown>>;
  return typeof member.userId === 'string' && typeof member.name === 'string' && typeof member.displayName === 'string'
    && isTeamRole(member.role) && (member.state === 'member' || member.state === 'invited');
}

function isTeamRow(value: unknown): value is TeamRow {
  if (!value || typeof value !== 'object') return false;
  const team = { ...value } as Partial<Record<keyof TeamRow, unknown>>;
  return typeof team.id === 'string' && typeof team.name === 'string' && typeof team.mayManage === 'boolean'
    && (team.myRole === null || isTeamRole(team.myRole))
    && (team.myState === null || team.myState === 'member' || team.myState === 'invited')
    && Array.isArray(team.members) && team.members.every(isTeamMemberRow)
    && Array.isArray(team.workspaces) && team.workspaces.every(name => typeof name === 'string');
}

function isTeamCandidate(value: unknown): value is TeamCandidate {
  if (!value || typeof value !== 'object') return false;
  const person = { ...value } as Partial<Record<keyof TeamCandidate, unknown>>;
  return typeof person.id === 'string' && typeof person.name === 'string' && typeof person.displayName === 'string';
}

function teamsListFrom(value: Record<string, unknown>): TeamsList | null {
  if (!Array.isArray(value.teams) || !Array.isArray(value.people)) return null;
  return { teams: value.teams.filter(isTeamRow), people: value.people.filter(isTeamCandidate) };
}

async function loadAccounts(signal: AbortSignal): Promise<Loaded> {
  const session = await callApi('/api/accounts/session', 'GET', undefined, signal);
  const loadedAt = Date.now();
  if (session.code === 'ACCOUNTS_DAMAGED' || session.body.mode === 'damaged') {
    return { kind: 'ready', mode: 'damaged', user: null, tokens: [], people: null, teams: null, loadedAt, problem: null };
  }
  if (!session.ok) return { kind: 'failed', message: session.error };
  if (session.body.mode !== 'on') {
    return { kind: 'ready', mode: 'off', user: null, tokens: [], people: null, teams: null, loadedAt, problem: null };
  }
  const user = isPerson(session.body.user) ? session.body.user : null;
  if (!user) return { kind: 'ready', mode: 'on', user: null, tokens: [], people: null, teams: null, loadedAt, problem: null };
  const [tokens, people, teams] = await Promise.all([
    callApi('/api/accounts/tokens', 'GET', undefined, signal),
    user.role === 'admin' ? callApi('/api/accounts/users', 'GET', undefined, signal) : Promise.resolve(null),
    callApi('/api/accounts/teams', 'GET', undefined, signal),
  ]);
  const problems = [tokens, people, teams].filter((result): result is ApiResult => result !== null && !result.ok);
  const peopleList = people?.ok && isPeopleList(people.body) ? people.body : null;
  return {
    kind: 'ready',
    mode: 'on',
    user,
    tokens: tokens.ok && Array.isArray(tokens.body.tokens) ? tokens.body.tokens.filter(isApiToken) : [],
    people: peopleList
      ? { ...peopleList, teams: Array.isArray(peopleList.teams) ? peopleList.teams.filter(isTeamName) : [] }
      : null,
    teams: teams.ok ? teamsListFrom(teams.body) : null,
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

/** `user:<id>` or `team:<id>`, so one list can offer people and teams. */
function ownerKey(ownerType: string | null, ownerId: string | null): string {
  return ownerType && ownerId ? `${ownerType}:${ownerId}` : '';
}

function WorkspaceOwnersPanel({ people, reload }: { people: PeopleList; reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const personName = (id: string | null) => {
    const person = people.users.find(candidate => candidate.id === id);
    return person ? `${person.displayName} (${person.name})` : 'Someone who no longer exists';
  };
  const teamName = (id: string | null) => {
    const team = people.teams.find(candidate => candidate.id === id);
    return team ? `Team: ${team.name}` : 'A team that no longer exists';
  };
  const ownerName = (key: string) => key.startsWith('team:') ? teamName(key.slice(5)) : personName(key.slice(5));
  const ownerText = (workspace: WorkspaceOwnerRow) => workspace.ownerType === 'user'
    ? personName(workspace.ownerId)
    : workspace.ownerType === 'team' ? teamName(workspace.ownerId) : 'Unassigned (admins only)';
  const chosen = (workspace: WorkspaceOwnerRow) => choice[workspace.name]
    ?? (ownerKey(workspace.ownerType, workspace.ownerId) || (people.users[0] ? `user:${people.users[0].id}` : ''));

  const give = async (workspace: WorkspaceOwnerRow) => {
    const key = chosen(workspace);
    if (!key) return;
    const ownerType = key.startsWith('team:') ? 'team' : 'user';
    const result = await send('/api/accounts/users', 'PUT', { workspace: workspace.name, ownerId: key.slice(5), ownerType });
    if (!result?.ok) return;
    setNotice({ severity: 'success', text: `${workspace.name} now belongs to ${ownerName(key)}.` });
    reload();
  };

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Workspaces</Typography>
      <Typography variant="body2" color="text.secondary">
        Each workspace belongs to one person or one team. Only that person, the people in that team, and admins can
        open it.
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
                        <option key={person.id} value={`user:${person.id}`}>
                          {person.displayName} ({person.name}){person.disabled ? ', turned off' : ''}
                        </option>
                      ))}
                      {people.teams.map(team => (
                        <option key={team.id} value={`team:${team.id}`}>Team: {team.name}</option>
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

function roleWords(role: TeamRole): string {
  return `${TEAM_ROLE_WORDS[role].label} (${TEAM_ROLE_WORDS[role].help})`;
}

function RoleOptions() {
  return (
    <>
      {TEAM_ROLES.map(role => <option key={role} value={role}>{roleWords(role)}</option>)}
    </>
  );
}

/** One invitation the signed-in person has not answered yet. */
function InvitationNotice({ team, reload }: { team: TeamRow; reload: () => void }) {
  const { busy, notice, send } = useAccountRequest();
  const answer = async (value: 'accept' | 'decline') => {
    const result = await send('/api/accounts/teams', 'PATCH', { teamId: team.id, answer: value });
    if (result?.ok) reload();
  };
  const role = team.myRole ?? 'member';
  return (
    <Stack spacing={1}>
      <Alert severity="info">
        <Stack spacing={1}>
          <span>
            You are invited to the team <strong>{team.name}</strong> as {TEAM_ROLE_WORDS[role].label.toLowerCase()}:
            you {TEAM_ROLE_WORDS[role].help}.
          </span>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button size="small" variant="contained" disabled={busy} aria-label={`Accept the invitation to ${team.name}`}
              onClick={() => void answer('accept')}>
              Accept
            </Button>
            <Button size="small" disabled={busy} aria-label={`Decline the invitation to ${team.name}`}
              onClick={() => void answer('decline')}>
              Decline
            </Button>
          </Box>
        </Stack>
      </Alert>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

function openWorkspace(name: string) {
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- switching workspaces needs a full page load, like the workspace tabs do
  window.location.assign(`/?workspace=${encodeURIComponent(name)}`);
}

interface TeamCardProps {
  team: TeamRow;
  people: TeamCandidate[];
  isAdmin: boolean;
  reload: () => void;
  announce: (notice: Notice) => void;
}

/** One team: its members, its workspaces and, for its owners and admins, the controls to change it. */
function TeamCard({ team, people, isAdmin, reload, announce }: TeamCardProps) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [how, setHow] = useState<'add' | 'invite'>('add');
  const [newName, setNewName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [madeWorkspace, setMadeWorkspace] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const candidates = people.filter(person => !team.members.some(member => member.userId === person.id));
  const chosenPerson = candidates.some(person => person.id === personId) ? personId : candidates[0]?.id ?? '';

  /** Send one change; on success show `done` and load the teams again. */
  const run = async (url: string, method: string, body: unknown, done: string): Promise<boolean> => {
    const result = await send(url, method, body);
    if (result?.code === 'ACCOUNTS_CHANGED') {
      setNotice({ severity: 'error', text: TEAMS_CHANGED });
      reload();
      return false;
    }
    if (!result?.ok) return false;
    setNotice({ severity: 'success', text: done });
    reload();
    return true;
  };
  const changeMember = (userId: string, change: Record<string, unknown>, done: string) =>
    run('/api/accounts/teams', 'PATCH', { teamId: team.id, member: { userId, ...change } }, done);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const person = candidates.find(candidate => candidate.id === chosenPerson);
    if (!person) return;
    const invite = how === 'invite';
    if (await changeMember(person.id, { role, ...(invite ? { invite: true } : {}) },
      invite ? `Invited ${person.displayName}. They join once they accept.` : `Added ${person.displayName} to ${team.name}.`)) {
      setPersonId('');
      setRole('member');
      setHow('add');
    }
  };
  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newName.trim()) return;
    if (await run('/api/accounts/teams', 'PATCH', { teamId: team.id, name: newName.trim() }, `The team is now called ${newName.trim()}.`)) {
      setNewName('');
    }
  };
  const makeWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = workspaceName.trim();
    if (!name) return;
    if (await run('/api/workspaces', 'POST', { name, teamId: team.id }, `Made the workspace ${name} for ${team.name}.`)) {
      setWorkspaceName('');
      setMadeWorkspace(name);
    }
  };
  const remove = async () => {
    const result = await send('/api/accounts/teams', 'DELETE', { teamId: team.id });
    if (!result?.ok) return;
    announce({ severity: 'success', text: `Deleted the team ${team.name}.` });
    reload();
  };

  return (
    <Box component="section" aria-label={`Team ${team.name}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 600 }}>{team.name}</Typography>
        <Typography variant="body2">
          {team.myRole
            ? `Your role: ${TEAM_ROLE_WORDS[team.myRole].label}. You ${TEAM_ROLE_WORDS[team.myRole].help}.`
            : 'You are not in this team. As an admin you can still manage it.'}
        </Typography>
        <Typography variant="body2">
          {team.workspaces.length > 0
            ? `Workspaces of this team: ${team.workspaces.join(', ')}.`
            : 'This team has no workspace yet.'}
        </Typography>
        <TableContainer>
          <Table size="small" aria-label={`Members of ${team.name}`}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Role</TableCell>
                <TableCell>Status</TableCell>
                {team.mayManage && <TableCell>Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {team.members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={team.mayManage ? 4 : 3}>Nobody is in this team yet.</TableCell>
                </TableRow>
              )}
              {team.members.map(member => (
                <TableRow key={member.userId}>
                  <TableCell>{member.displayName} ({member.name})</TableCell>
                  <TableCell>
                    {team.mayManage
                      ? (
                        <TextField select size="small" label={`Role of ${member.name} in ${team.name}`} value={member.role}
                          disabled={busy} slotProps={{ select: { native: true } }}
                          onChange={event => {
                            const next = event.target.value;
                            if (isTeamRole(next) && next !== member.role) {
                              void changeMember(member.userId, { role: next },
                                `${member.displayName} is now ${TEAM_ROLE_WORDS[next].label.toLowerCase()} in ${team.name}.`);
                            }
                          }}>
                          <RoleOptions />
                        </TextField>
                      )
                      : TEAM_ROLE_WORDS[member.role].label}
                  </TableCell>
                  <TableCell>{member.state === 'invited' ? 'Invited, has not answered yet' : 'In the team'}</TableCell>
                  {team.mayManage && (
                    <TableCell>
                      {removing === member.userId
                        ? (
                          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Typography variant="body2">Remove {member.displayName} from {team.name}?</Typography>
                            <Button size="small" color="error" variant="contained" disabled={busy}
                              onClick={() => {
                                setRemoving(null);
                                void changeMember(member.userId, { remove: true }, `Removed ${member.displayName} from ${team.name}.`);
                              }}>
                              Yes, remove
                            </Button>
                            <Button size="small" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
                          </Box>
                        )
                        : (
                          <Button size="small" color="error" disabled={busy}
                            aria-label={`Remove ${member.name} from ${team.name}`} onClick={() => setRemoving(member.userId)}>
                            Remove
                          </Button>
                        )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {team.mayManage && (
          <>
            {candidates.length > 0
              ? (
                <Box component="form" onSubmit={add} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <TextField select size="small" label={`Person to add to ${team.name}`} value={chosenPerson} disabled={busy}
                    slotProps={{ select: { native: true } }} onChange={event => setPersonId(event.target.value)}>
                    {candidates.map(person => (
                      <option key={person.id} value={person.id}>{person.displayName} ({person.name})</option>
                    ))}
                  </TextField>
                  <TextField select size="small" label={`Role in ${team.name}`} value={role} disabled={busy}
                    slotProps={{ select: { native: true } }}
                    onChange={event => { if (isTeamRole(event.target.value)) setRole(event.target.value); }}>
                    <RoleOptions />
                  </TextField>
                  <TextField select size="small" label={`How to add to ${team.name}`} value={how} disabled={busy}
                    slotProps={{ select: { native: true } }}
                    onChange={event => setHow(event.target.value === 'invite' ? 'invite' : 'add')}>
                    <option value="add">Add now</option>
                    <option value="invite">Invite (they accept first)</option>
                  </TextField>
                  <Button type="submit" variant="outlined" disabled={busy || !chosenPerson}>Add to team</Button>
                </Box>
              )
              : <Typography variant="body2">Everyone who can sign in is already in this team.</Typography>}
            <Box component="form" onSubmit={makeWorkspace} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <TextField size="small" label={`New workspace for ${team.name}`} value={workspaceName} disabled={busy}
                helperText="Letters, digits, dashes or underscores. Everyone in the team can open it."
                onChange={event => setWorkspaceName(event.target.value)} />
              <Button type="submit" variant="outlined" disabled={busy || !workspaceName.trim()}>Make team workspace</Button>
            </Box>
            {madeWorkspace && (
              <Box>
                <Button size="small" onClick={() => openWorkspace(madeWorkspace)}>Open {madeWorkspace}</Button>
              </Box>
            )}
            <Box component="form" onSubmit={rename} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <TextField size="small" label={`New name for ${team.name}`} value={newName} disabled={busy}
                onChange={event => setNewName(event.target.value)} />
              <Button type="submit" variant="outlined" disabled={busy || !newName.trim()}>Rename team</Button>
            </Box>
          </>
        )}
        {isAdmin && (deleting
          ? (
            <Alert severity="warning">
              <Stack spacing={1}>
                <span>
                  Delete the team {team.name}? Its people keep their own accounts and workspaces. A team that still owns
                  workspaces cannot be deleted: give those workspaces to someone else first.
                </span>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Button color="error" variant="contained" disabled={busy}
                    onClick={() => { setDeleting(false); void remove(); }}>
                    Yes, delete team
                  </Button>
                  <Button disabled={busy} onClick={() => setDeleting(false)}>Cancel</Button>
                </Box>
              </Stack>
            </Alert>
          )
          : (
            <Box>
              <Button size="small" color="error" variant="outlined" disabled={busy}
                aria-label={`Delete the team ${team.name}`} onClick={() => setDeleting(true)}>
                Delete team
              </Button>
            </Box>
          ))}
        <NoticeAlert notice={notice} />
      </Stack>
    </Box>
  );
}

/** Admins make teams; the first owner is optional because an admin can manage any team. */
function MakeTeamForm({ people, reload }: { people: TeamCandidate[]; reload: () => void }) {
  const { busy, notice, setNotice, send } = useAccountRequest();
  const [name, setName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const teamName = name.trim();
    if (!teamName) {
      setNotice({ severity: 'error', text: 'Give the team a name.' });
      return;
    }
    const result = await send('/api/accounts/teams', 'POST', { name: teamName, ...(ownerId ? { ownerUserId: ownerId } : {}) });
    if (!result?.ok) return;
    setNotice({ severity: 'success', text: `Made the team ${teamName}.` });
    setName('');
    setOwnerId('');
    reload();
  };
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 600 }}>Make a team</Typography>
      <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 480 }}>
        <TextField label="Team name" value={name} disabled={busy} onChange={event => setName(event.target.value)} />
        <TextField select label="First owner (optional)" value={ownerId} disabled={busy}
          helperText="The owner can add people and make workspaces for the team. You can manage every team anyway."
          slotProps={{ select: { native: true } }} onChange={event => setOwnerId(event.target.value)}>
          <option value="">Nobody yet</option>
          {people.map(person => <option key={person.id} value={person.id}>{person.displayName} ({person.name})</option>)}
        </TextField>
        <Box>
          <Button type="submit" variant="contained" disabled={busy}>Make team</Button>
        </Box>
      </Box>
      <NoticeAlert notice={notice} />
    </Stack>
  );
}

/**
 * Teams (#575): every signed-in person sees their teams and invitations. Team
 * owners and admins change members, roles, names and team workspaces; admins
 * make and delete teams.
 */
function TeamsPanel({ teams, isAdmin, reload }: { teams: TeamsList; isAdmin: boolean; reload: () => void }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const invitations = teams.teams.filter(team => team.myState === 'invited');
  const shown = teams.teams.filter(team => team.myState === 'member' || (isAdmin && team.myState === null));
  return (
    <Stack spacing={1.5}>
      <Typography variant="h6" component="h3">Teams</Typography>
      <Typography variant="body2" color="text.secondary">
        A team owns its own workspaces, and everyone in the team can open them. Owners can do everything, also manage
        the team. Members can change and run things. Viewers can only look. Only owners and admins can show saved keys
        and passwords.
      </Typography>
      {invitations.map(team => <InvitationNotice key={team.id} team={team} reload={reload} />)}
      {shown.length === 0 && (
        <Typography variant="body2">
          {isAdmin ? 'There are no teams yet.' : 'You are not in a team yet. An admin or a team owner can add you.'}
        </Typography>
      )}
      {shown.map(team => (
        <TeamCard key={team.id} team={team} people={teams.people} isAdmin={isAdmin} reload={reload} announce={setNotice} />
      ))}
      <NoticeAlert notice={notice} />
      {isAdmin && <MakeTeamForm people={teams.people} reload={reload} />}
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
 * workspace owners and API tokens (#574), and teams (#575). Turning the mode on or off reloads
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
      {loaded.teams && <TeamsPanel teams={loaded.teams} isAdmin={loaded.user.role === 'admin'} reload={reload} />}
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
