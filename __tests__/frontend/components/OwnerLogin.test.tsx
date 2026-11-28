import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OwnerLoginPage from '@/app/owner/login/page';
import AppWrapper from '@/frontend/components/AppWrapper';
import WorkspaceBootstrap from '@/frontend/components/WorkspaceBootstrap';

const mockReplace = jest.fn();
const mockRefresh = jest.fn();
let mockPathname = '/owner/login';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
}));
jest.mock('@/frontend/components/WorkspaceBootstrap', () => ({
  __esModule: true, default: jest.fn(() => <div data-testid="workspace-bootstrap" />),
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useI18n: () => ({ t: (key: string) => key }),
}));
jest.mock('@/frontend/components/AmbientWorld/LivingWorldGate', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/AvatarWorld/AvatarPanelBridge', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ AskFlujoProvider: () => null }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), error: jest.fn() }) }));

const savedFetch = global.fetch;
const ownerSessionCalls = () => jest.mocked(global.fetch).mock.calls.filter(([url]) => url === '/api/owner/session');
beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/owner/login';
  window.history.replaceState({}, '', '/owner/login');
  global.fetch = jest.fn();
});
afterEach(() => { global.fetch = savedFetch; jest.restoreAllMocks(); });

test('renders sign-in before protected workspace/bootstrap providers', () => {
  render(<AppWrapper><OwnerLoginPage /></AppWrapper>);
  expect(screen.getByLabelText('Owner credential')).toBeInTheDocument();
  expect(WorkspaceBootstrap).not.toHaveBeenCalled();
});

test('only the exact sign-in page bypasses workspace bootstrap', () => {
  mockPathname = '/';
  render(<AppWrapper><div>ordinary page</div></AppWrapper>);
  expect(WorkspaceBootstrap).toHaveBeenCalled();
  expect(screen.getByTestId('workspace-bootstrap')).toBeInTheDocument();
});

test('exchanges a transient credential, clears it and navigates after success without browser storage', async () => {
  jest.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
  const store = jest.spyOn(Storage.prototype, 'setItem');
  render(<OwnerLoginPage />);
  const input = screen.getByLabelText('Owner credential');
  fireEvent.change(input, { target: { value: 'synthetic-owner-bearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith('/api/owner/session', {
    method: 'POST', credentials: 'same-origin', signal: expect.any(AbortSignal), headers: { Authorization: 'Bearer synthetic-owner-bearer' },
  });
  expect(input).toHaveValue('');
  expect(store).not.toHaveBeenCalled();
});

test('does not render raw server diagnostics or retain a denied credential', async () => {
  const json = jest.fn().mockResolvedValue({ error: 'synthetic-private-path-or-secret' });
  jest.mocked(global.fetch).mockResolvedValue({ ok: false, status: 401, json } as unknown as Response);
  render(<OwnerLoginPage />);
  const input = screen.getByLabelText('Owner credential');
  fireEvent.change(input, { target: { value: 'invalid-private-bearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('status')).toHaveTextContent('invalid, expired or revoked');
  expect(input).toHaveValue('');
  expect(json).not.toHaveBeenCalled();
  expect(screen.queryByText('synthetic-private-path-or-secret')).not.toBeInTheDocument();
});

test('clears a transient credential when the network request fails', async () => {
  jest.mocked(global.fetch).mockRejectedValue(new Error('synthetic-private-network-error'));
  render(<OwnerLoginPage />);
  const input = screen.getByLabelText('Owner credential');
  fireEvent.change(input, { target: { value: 'transient-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Could not reach owner authentication');
  expect(input).toHaveValue('');
});

test('signs out through the cookie-authenticated DELETE without a bearer', async () => {
  jest.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
  render(<OwnerLoginPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Signed out.');
  expect(global.fetch).toHaveBeenCalledWith('/api/owner/session', { method: 'DELETE', credentials: 'same-origin', signal: expect.any(AbortSignal) });
});

test.each(['/chat?workspace=team-b', '//attacker.test/steal', '/\\attacker.test/steal'])('keeps the post-login destination same-origin (%s)', destination => {
  window.history.replaceState({}, '', `/owner/login?returnTo=${encodeURIComponent(destination)}`);
  jest.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);
  render(<OwnerLoginPage />);
  fireEvent.change(screen.getByLabelText('Owner credential'), { target: { value: 'synthetic-bearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  return waitFor(() => expect(mockReplace).toHaveBeenCalledWith(destination === '/chat?workspace=team-b' ? destination : '/'));
});

test('duplicate form submissions admit one session mutation before rendering busy state', async () => {
  let resolve!: (response: Response) => void;
  jest.mocked(global.fetch).mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  render(<OwnerLoginPage />);
  const input = screen.getByLabelText('Owner credential');
  fireEvent.change(input, { target: { value: 'private-owner-bearer' } });
  const form = input.closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(ownerSessionCalls()).toHaveLength(1);
  resolve({ ok: true } as Response);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
});
test('leaving the sign-in page aborts the mutation and ignores a late success instead of navigating', async () => {
  let resolve!: (response: Response) => void;
  jest.mocked(global.fetch).mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  const { unmount } = render(<OwnerLoginPage />);
  fireEvent.change(screen.getByLabelText('Owner credential'), { target: { value: 'private-owner-bearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const options = ownerSessionCalls()[0][1]!;
  unmount(); expect(options.signal!.aborted).toBe(true);
  resolve({ ok: true } as Response);
  await waitFor(() => expect(mockReplace).not.toHaveBeenCalled());
  expect(mockRefresh).not.toHaveBeenCalled();
});

describe('multi-user mode (#574)', () => {
  const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
  function serve(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
    jest.mocked(global.fetch).mockImplementation(async (input, init) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const route = routes[key];
      if (!route) throw new Error(`unexpected request ${key}`);
      return route(init);
    });
  }

  test('keeps the owner credential page while multi-user mode is off', async () => {
    serve({ 'GET /api/accounts/session': () => answer(200, { mode: 'off', user: null }) });
    render(<OwnerLoginPage />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/accounts/session', expect.objectContaining({ credentials: 'same-origin' })));
    expect(screen.getByRole('heading', { name: 'Owner sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Owner credential')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  test('signs in with a name and password and goes back to the page the person came from', async () => {
    window.history.replaceState({}, '', `/owner/login?returnTo=${encodeURIComponent('/flows?workspace=ada-private')}`);
    const signIn = jest.fn((_init?: RequestInit) => answer(200, { user: { id: 'u_1', name: 'ada', displayName: 'Ada' } }));
    serve({ 'GET /api/accounts/session': () => answer(200, { mode: 'on', user: null }), 'POST /api/accounts/session': signIn });
    render(<OwnerLoginPage />);
    expect(await screen.findByRole('heading', { name: 'Sign in to FLUJO' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Owner credential')).not.toBeInTheDocument();
    expect(screen.queryByText('Pair the first owner')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long enough test password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/flows?workspace=ada-private'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ name: 'ada', password: 'a long enough test password' }),
    }));
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  test('shows the server message when sign-in is refused and clears the password', async () => {
    serve({
      'GET /api/accounts/session': () => answer(200, { mode: 'on', user: null }),
      'POST /api/accounts/session': () => answer(401, { error: 'The name or password is not right.', code: 'SIGN_IN_FAILED' }),
    });
    render(<OwnerLoginPage />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong test password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The name or password is not right.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  test('shows who is signed in and signs out', async () => {
    serve({
      'GET /api/accounts/session': () => answer(200, { mode: 'on', user: { id: 'u_1', name: 'ada', displayName: 'Ada' } }),
      'DELETE /api/accounts/session': () => answer(200, { signedIn: false }),
    });
    render(<OwnerLoginPage />);
    expect(await screen.findByText('Signed in as Ada.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Signed out.');
    expect(screen.queryByText('Signed in as Ada.')).not.toBeInTheDocument();
  });

  test.each([
    ['the session check says so', () => answer(200, { mode: 'damaged', user: null })],
    ['the server refuses every request', () => answer(503, { error: 'damaged', code: 'ACCOUNTS_DAMAGED' })],
  ])('explains that sign-in is unavailable when the accounts file is damaged (%s)', async (_case, reply) => {
    serve({ 'GET /api/accounts/session': reply });
    render(<OwnerLoginPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('An admin must fix that file on the server.');
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
