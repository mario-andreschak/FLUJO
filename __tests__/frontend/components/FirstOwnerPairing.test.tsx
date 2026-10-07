import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FirstOwnerPairing from '@/frontend/components/FirstOwnerPairing';
const mockReplace = jest.fn(); const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }) }));
const savedFetch = global.fetch; let mockFetch: jest.Mock;
const capability = `flo_v1_${'a'.repeat(43)}`; const ownerToken = `flo_v1_${'b'.repeat(43)}`;
beforeEach(() => { mockReplace.mockReset(); mockRefresh.mockReset(); mockFetch = jest.fn(); global.fetch = mockFetch; });
afterEach(() => { global.fetch = savedFetch; });
function fill() {
  fireEvent.change(screen.getByLabelText('Local pairing capability'), { target: { value: capability } });
  fireEvent.click(screen.getByRole('checkbox'));
}
test('pairing requires explicit capability and confirmation without automatic mutation', () => {
  render(<FirstOwnerPairing />);
  expect(screen.getByRole('button', { name: 'Pair owner' })).toBeDisabled();
  expect(mockFetch).not.toHaveBeenCalled();
});
test('successful first pairing clears the proof, returns the new credential once and never stores it', async () => {
  mockFetch.mockResolvedValue({ status: 201, json: async () => ({ ownerToken, authenticated: true }) });
  const storage = jest.spyOn(Storage.prototype, 'setItem'); render(<FirstOwnerPairing />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'Pair owner' }));
  expect(await screen.findByLabelText('New owner credential')).toHaveValue(ownerToken);
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ confirmOwnerEnrollment: true });
  expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${capability}`);
  expect(storage).not.toHaveBeenCalled(); expect(mockReplace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'I saved the credential; continue' }));
  expect(mockReplace).toHaveBeenCalledWith('/'); expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('New owner credential')).not.toBeInTheDocument(); storage.mockRestore();
});
test('failure uses fixed recovery text, clears the capability and avoids server diagnostics', async () => {
  mockFetch.mockResolvedValue({ status: 400, json: async () => ({ error: 'private-server-diagnostic' }) });
  render(<FirstOwnerPairing />); fill(); fireEvent.click(screen.getByRole('button', { name: 'Pair owner' }));
  await screen.findByRole('status'); expect(screen.getByLabelText('Local pairing capability')).toHaveValue('');
  expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.queryByText('private-server-diagnostic')).not.toBeInTheDocument();
});
test('teardown aborts enrollment and ignores a late response without navigation', async () => {
  let resolve!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { unmount } = render(<FirstOwnerPairing />); fill(); fireEvent.click(screen.getByRole('button', { name: 'Pair owner' }));
  unmount(); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  resolve({ status: 201, json: async () => ({ ownerToken, authenticated: true }) });
  await waitFor(() => expect(mockReplace).not.toHaveBeenCalled());
});
