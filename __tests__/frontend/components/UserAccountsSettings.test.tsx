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

  expect(await screen.findByText(/Let several people use this FLUJO/)).toBeInTheDocument();
  expect(screen.getByText(/everyone must sign in to use FLUJO/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Your sign-in name'), { target: { value: 'ada' } });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.change(screen.getByLabelText('Repeat password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in for several people' }));

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
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in for several people' }));
  expect(await screen.findByText('Use a password of at least 15 characters.')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in for several people' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Turn on sign-in for several people' }));
  expect(await screen.findByText('Use a sign-in name of 1 to 64 lower-case letters.')).toBeInTheDocument();
  expect(reloadPage).not.toHaveBeenCalled();
});

test('a member sees who is signed in and their own tokens, and a new token is shown once', async () => {
  let tokens = [{ id: 'tok_1', label: 'Laptop script', scopes: ['flows:run'], issuedAt: 1, expiresAt: 4_102_444_800_000, revokedAt: null }];
  serve({
    'GET /api/accounts/session': () => answer(200, { mode: 'on', user: bob }),
    'GET /api/accounts/tokens': () => answer(200, { tokens }),
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
    'GET /api/accounts/users': () => answer(200, {
      revision: 7,
      me: ada.id,
      users: [ada, bob],
      workspaces: [
        { name: 'default-workspace', ownerType: 'user', ownerId: ada.id },
        { name: 'old-team', ownerType: oldTeamOwner ? 'user' : null, ownerId: oldTeamOwner },
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
  fireEvent.change(within(oldTeam).getByLabelText('New owner of old-team'), { target: { value: bob.id } });
  fireEvent.click(within(oldTeam).getByRole('button', { name: 'Give to' }));
  await waitFor(() => expect(gifts).toEqual([{ workspace: 'old-team', ownerId: bob.id }]));
  expect(await within(oldTeam).findByText('Bob (bob)', { selector: 'td' })).toBeInTheDocument();

  expect(screen.getByRole('button', { name: 'Add person' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off sign-in for several people' }));
  expect(screen.getByText(/Nothing is deleted. Everyone is signed out/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Yes, turn it off' })).toBeInTheDocument();
});
