/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import UserAccountsSettings from '@/frontend/components/Settings/UserAccountsSettings';

const PASSWORD = 'a long enough test password';
const fetchMock = jest.fn();
const originalFetch = global.fetch;

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
type Route = (body: unknown) => ReturnType<typeof answer>;

function serve(routes: Record<string, Route>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    return route(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
  });
}

const ada = { id: 'u_ada', name: 'ada', displayName: 'Ada', role: 'admin', hostAccess: true, disabled: false, createdAt: 1 };
const bob = { id: 'u_bob', name: 'bob', displayName: 'Bob', role: 'member', hostAccess: false, disabled: false, createdAt: 2 };

beforeEach(() => { jest.clearAllMocks(); global.fetch = fetchMock; });
afterAll(() => { global.fetch = originalFetch; });

test('while multi-user mode is off it explains the option and turns it on with the form values', async () => {
  const turnOn = jest.fn<ReturnType<Route>, [unknown]>(() => answer(200, { mode: 'on', user: ada }));
  serve({ 'GET /api/accounts/session': () => answer(200, { mode: 'off', user: null }), 'POST /api/accounts/mode': turnOn });
  const reloadPage = jest.fn();
  render(<UserAccountsSettings reloadPage={reloadPage} />);

  expect(await screen.findByText(/also if you are the only person using FLUJO/)).toBeInTheDocument();
  expect(screen.getByLabelText('Your sign-in name')).toHaveValue('owner');
  expect(screen.getByText(/everyone must sign in to use FLUJO/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Your sign-in name'), { target: { value: 'ada' } });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in' }));

  await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
  expect(turnOn).toHaveBeenCalledWith({ enabled: true, name: 'ada', displayName: 'Ada', password: PASSWORD });
  expect(fetchMock).toHaveBeenCalledWith('/api/accounts/mode', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
});

test('does not send a password that is too short or not repeated the same', async () => {
  serve({ 'GET /api/accounts/session': () => answer(200, { mode: 'off', user: null }) });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);
  fireEvent.change(await screen.findByLabelText('Your sign-in name'), { target: { value: 'ada' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
  fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in' }));
  expect(await screen.findByText('Use a password of at least 15 characters.')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in' }));
  expect(await screen.findByText('The two passwords are not the same.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('shows the server message when turning it on is refused', async () => {
  serve({
    'GET /api/accounts/session': () => answer(200, { mode: 'off', user: null }),
    'POST /api/accounts/mode': () => answer(400, { error: 'Use a sign-in name of 1 to 64 lower-case letters.' }),
  });
  const reloadPage = jest.fn();
  render(<UserAccountsSettings reloadPage={reloadPage} />);
  fireEvent.change(await screen.findByLabelText('Your sign-in name'), { target: { value: 'Not Valid' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in' }));
  expect(await screen.findByText('Use a sign-in name of 1 to 64 lower-case letters.')).toBeInTheDocument();
  expect(reloadPage).not.toHaveBeenCalled();
});

test('a member sees who is signed in and their own tokens, and a new token is shown once', async () => {
  let tokens = [{ id: 'tok_1', label: 'Laptop script', scopes: ['flows:run'], issuedAt: 1, expiresAt: 4_102_444_800_000, revokedAt: null }];
  serve({
    'GET /api/accounts/session': () => answer(200, { mode: 'on', user: bob }),
    'GET /api/accounts/tokens': () => answer(200, { tokens }),
    'GET /api/accounts/teams': () => answer(200, { revision: 1, teams: [], people: [] }),
    'POST /api/accounts/tokens': body => {
      tokens = [...tokens, { id: 'tok_2', label: (body as { label: string }).label, scopes: ['flows:run'], issuedAt: 2, expiresAt: 4_102_444_800_000, revokedAt: null }];
      return answer(201, { token: 'flo_v1_synthetic-test-token', record: tokens[1] });
    },
  });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  expect(await screen.findByText('Bob')).toBeInTheDocument();
  expect(screen.getByText(/Signed in as/)).toHaveTextContent('Signed in as Bob.');
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  expect(screen.getByText('Laptop script')).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'People' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Turn off sign-in for several people' })).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/accounts/users', expect.anything());

  fireEvent.change(screen.getByLabelText('Token label'), { target: { value: 'Build server' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
  expect(await screen.findByDisplayValue('flo_v1_synthetic-test-token')).toBeInTheDocument();
  expect(screen.getByText('Copy this token now. It is not shown again.')).toBeInTheDocument();
  expect(await screen.findByText('Build server')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByDisplayValue('flo_v1_synthetic-test-token')).not.toBeInTheDocument();
});

test('an admin manages people and workspace owners', async () => {
  const changes: unknown[] = [];
  const gifts: unknown[] = [];
  let oldTeamOwner: string | null = null;
  serve({
    'GET /api/accounts/session': () => answer(200, { mode: 'on', user: ada }),
    'GET /api/accounts/tokens': () => answer(200, { tokens: [] }),
    'GET /api/accounts/teams': () => answer(200, { revision: 7, teams: [], people: [] }),
    'GET /api/accounts/users': () => answer(200, {
      revision: 7,
      me: ada.id,
      users: [ada, bob],
      teams: [{ id: 't_sales', name: 'Sales' }],
      workspaces: [
        { name: 'default-workspace', ownerType: 'user', ownerId: ada.id },
        { name: 'old-team', ownerType: oldTeamOwner ? 'user' : null, ownerId: oldTeamOwner },
        { name: 'sales-ws', ownerType: 'team', ownerId: 't_sales' },
      ],
    }),
    'PATCH /api/accounts/users': body => { changes.push(body); return answer(200, { user: bob }); },
    'PUT /api/accounts/users': body => {
      gifts.push(body);
      oldTeamOwner = (body as { ownerId: string }).ownerId;
      return answer(200, body);
    },
  });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  const people = await screen.findByRole('table', { name: 'People' });
  expect(screen.getByText(/Host access lets a person run programs and read every file on the server/)).toBeInTheDocument();
  const bobRow = within(people).getByText('bob').closest('tr')!;
  expect(within(within(people).getByText('ada (you)').closest('tr')!)
    .queryByRole('button', { name: 'Allow host access' })).not.toBeInTheDocument();

  fireEvent.click(within(bobRow).getByRole('button', { name: 'Allow host access' }));
  await waitFor(() => expect(changes).toEqual([{ id: bob.id, hostAccess: true, expectedRevision: 7 }]));
  expect(await screen.findByText('Allowed host access for Bob.')).toBeInTheDocument();

  fireEvent.click(within(bobRow).getByRole('button', { name: 'Set new password' }));
  fireEvent.change(within(bobRow).getByLabelText('New password for bob'), { target: { value: PASSWORD } });
  fireEvent.click(within(bobRow).getByRole('button', { name: 'Save password' }));
  await waitFor(() => expect(changes).toContainEqual({ id: bob.id, password: PASSWORD, expectedRevision: 7 }));

  const workspaces = screen.getByRole('table', { name: 'Workspaces' });
  const oldTeam = within(workspaces).getByText('old-team').closest('tr')!;
  expect(within(oldTeam).getByText('Unassigned (admins only)')).toBeInTheDocument();
  expect(within(within(workspaces).getByText('sales-ws').closest('tr')!).getByText('Team: Sales', { selector: 'td' })).toBeInTheDocument();
  expect(within(oldTeam).getByRole('option', { name: 'Team: Sales' })).toBeInTheDocument();
  fireEvent.change(within(oldTeam).getByLabelText('New owner of old-team'), { target: { value: `user:${bob.id}` } });
  fireEvent.click(within(oldTeam).getByRole('button', { name: 'Give to' }));
  await waitFor(() => expect(gifts).toEqual([{ workspace: 'old-team', ownerId: bob.id, ownerType: 'user' }]));
  expect(await within(oldTeam).findByText('Bob (bob)', { selector: 'td' })).toBeInTheDocument();

  expect(screen.getByRole('button', { name: 'Add person' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off sign-in for several people' }));
  expect(screen.getByText(/Nothing is deleted. Everyone is signed out/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Yes, turn it off' })).toBeInTheDocument();
});

const cleo = { id: 'u_cleo', name: 'cleo', displayName: 'Cleo', role: 'member', hostAccess: false, disabled: false, createdAt: 3 };
const member = (person: { id: string; name: string; displayName: string }, role: string, state = 'member') =>
  ({ userId: person.id, name: person.name, displayName: person.displayName, role, state });
const salesTeam = (overrides: Record<string, unknown> = {}) => ({
  id: 't_sales', name: 'Sales', createdAt: 1, myRole: 'member', myState: 'member', mayManage: false,
  members: [member(ada, 'owner'), member(bob, 'member')], workspaces: ['sales-ws'], ...overrides,
});

function serveTeams(user: typeof bob, teams: () => unknown, people: unknown[], extra: Record<string, Route> = {}) {
  serve({
    'GET /api/accounts/session': () => answer(200, { mode: 'on', user }),
    'GET /api/accounts/tokens': () => answer(200, { tokens: [] }),
    'GET /api/accounts/teams': () => answer(200, { revision: 3, teams: teams(), people }),
    ...extra,
  });
}

test('a member sees their team, its workspaces and roles in plain words, without controls to change it', async () => {
  serveTeams(bob, () => [salesTeam()], []);
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  const team = await screen.findByRole('region', { name: 'Team Sales' });
  expect(within(team).getByText('Your role: Member. You can change and run things.')).toBeInTheDocument();
  expect(within(team).getByText('Workspaces of this team: sales-ws.')).toBeInTheDocument();
  const members = within(team).getByRole('table', { name: 'Members of Sales' });
  expect(within(members).getByText('Owner')).toBeInTheDocument();
  expect(within(members).getByText('Ada (ada)')).toBeInTheDocument();
  expect(within(team).queryByRole('button', { name: 'Add to team' })).not.toBeInTheDocument();
  expect(within(team).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  expect(within(team).queryByRole('button', { name: 'Make team workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Make team' })).not.toBeInTheDocument();
});

test('a viewer only looks: no buttons to change the team', async () => {
  serveTeams(cleo, () => [salesTeam({ myRole: 'viewer', members: [member(ada, 'owner'), member(cleo, 'viewer')] })], []);
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  const team = await screen.findByRole('region', { name: 'Team Sales' });
  expect(within(team).getByText('Your role: Viewer. You can only look.')).toBeInTheDocument();
  expect(within(team).queryAllByRole('button')).toHaveLength(0);
  expect(within(team).queryByRole('combobox')).not.toBeInTheDocument();
});

test('a team owner adds, invites, re-roles and removes people and makes a team workspace', async () => {
  const patches: unknown[] = [];
  const created: unknown[] = [];
  serveTeams(ada, () => [salesTeam({ myRole: 'owner', mayManage: true })], [ada, bob, cleo], {
    'PATCH /api/accounts/teams': body => { patches.push(body); return answer(200, { team: salesTeam() }); },
    'POST /api/workspaces': body => { created.push(body); return answer(201, { workspace: { name: 'sales-2' }, workspaces: [] }); },
    'GET /api/accounts/users': () => answer(200, { revision: 3, me: ada.id, users: [ada, bob, cleo], teams: [], workspaces: [] }),
  });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  const team = await screen.findByRole('region', { name: 'Team Sales' });
  const people = within(team).getByLabelText('Person to add to Sales');
  expect(within(people).getAllByRole('option').map(option => option.textContent)).toEqual(['Cleo (cleo)']);
  fireEvent.change(within(team).getByLabelText('Role in Sales'), { target: { value: 'viewer' } });
  fireEvent.change(within(team).getByLabelText('How to add to Sales'), { target: { value: 'invite' } });
  fireEvent.click(within(team).getByRole('button', { name: 'Add to team' }));
  await waitFor(() => expect(patches).toEqual([{ teamId: 't_sales', member: { userId: cleo.id, role: 'viewer', invite: true } }]));
  expect(await within(team).findByText('Invited Cleo. They join once they accept.')).toBeInTheDocument();

  fireEvent.change(within(team).getByLabelText('Role of bob in Sales'), { target: { value: 'viewer' } });
  await waitFor(() => expect(patches).toContainEqual({ teamId: 't_sales', member: { userId: bob.id, role: 'viewer' } }));

  fireEvent.click(within(team).getByRole('button', { name: 'Remove bob from Sales' }));
  expect(within(team).getByText('Remove Bob from Sales?')).toBeInTheDocument();
  fireEvent.click(within(team).getByRole('button', { name: 'Yes, remove' }));
  await waitFor(() => expect(patches).toContainEqual({ teamId: 't_sales', member: { userId: bob.id, remove: true } }));

  fireEvent.change(within(team).getByLabelText('New workspace for Sales'), { target: { value: 'sales-2' } });
  fireEvent.click(within(team).getByRole('button', { name: 'Make team workspace' }));
  await waitFor(() => expect(created).toEqual([{ name: 'sales-2', teamId: 't_sales' }]));
  expect(await within(team).findByRole('button', { name: 'Open sales-2' })).toBeInTheDocument();
});

test('an invited person accepts the invitation', async () => {
  let state = 'invited';
  const patches: unknown[] = [];
  serveTeams(cleo, () => [salesTeam({ myRole: 'viewer', myState: state, members: [member(ada, 'owner'), member(cleo, 'viewer', state)] })], [], {
    'PATCH /api/accounts/teams': body => { patches.push(body); state = 'member'; return answer(200, { team: salesTeam() }); },
  });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  expect(await screen.findByText(/You are invited to the team/)).toHaveTextContent('You are invited to the team Sales as viewer: you can only look.');
  expect(screen.queryByRole('region', { name: 'Team Sales' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Accept the invitation to Sales' }));
  await waitFor(() => expect(patches).toEqual([{ teamId: 't_sales', answer: 'accept' }]));
  expect(await screen.findByRole('region', { name: 'Team Sales' })).toBeInTheDocument();
  expect(screen.queryByText(/You are invited to the team/)).not.toBeInTheDocument();
});

test('an admin makes a team and sees the reason when deleting one is refused', async () => {
  const posts: unknown[] = [];
  serveTeams(ada, () => [salesTeam({ myRole: null, myState: null, mayManage: true })], [ada, bob], {
    'POST /api/accounts/teams': body => { posts.push(body); return answer(201, { team: salesTeam() }); },
    'DELETE /api/accounts/teams': () => answer(409, { error: 'This team still owns sales-ws. Give those workspaces to someone else first.' }),
    'GET /api/accounts/users': () => answer(200, { revision: 3, me: ada.id, users: [ada, bob], teams: [{ id: 't_sales', name: 'Sales' }], workspaces: [] }),
  });
  render(<UserAccountsSettings reloadPage={jest.fn()} />);

  const team = await screen.findByRole('region', { name: 'Team Sales' });
  expect(within(team).getByText('You are not in this team. As an admin you can still manage it.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Support' } });
  fireEvent.change(screen.getByLabelText('First owner (optional)'), { target: { value: bob.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Make team' }));
  await waitFor(() => expect(posts).toEqual([{ name: 'Support', ownerUserId: bob.id }]));
  expect(await screen.findByText('Made the team Support.')).toBeInTheDocument();

  fireEvent.click(within(team).getByRole('button', { name: 'Delete the team Sales' }));
  fireEvent.click(within(team).getByRole('button', { name: 'Yes, delete team' }));
  expect(await within(team).findByText('This team still owns sales-ws. Give those workspaces to someone else first.')).toBeInTheDocument();
});
