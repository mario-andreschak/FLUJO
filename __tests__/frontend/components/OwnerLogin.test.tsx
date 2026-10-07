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
jest.mock('next/dynamic', () => ({ __esModule: true, default: () => () => null }));
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
  expect(global.fetch).toHaveBeenCalledTimes(1);
  resolve({ ok: true } as Response);
  await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
});
test('leaving the sign-in page aborts the mutation and ignores a late success instead of navigating', async () => {
  let resolve!: (response: Response) => void;
  jest.mocked(global.fetch).mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
  const { unmount } = render(<OwnerLoginPage />);
  fireEvent.change(screen.getByLabelText('Owner credential'), { target: { value: 'private-owner-bearer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  const options = jest.mocked(global.fetch).mock.calls[0][1]!;
  unmount(); expect(options.signal!.aborted).toBe(true);
  resolve({ ok: true } as Response);
  await waitFor(() => expect(mockReplace).not.toHaveBeenCalled());
  expect(mockRefresh).not.toHaveBeenCalled();
});
