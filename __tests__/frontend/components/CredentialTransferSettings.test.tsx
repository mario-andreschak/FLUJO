/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CredentialTransferSettings from '@/frontend/components/Settings/CredentialTransferSettings';

let selected = 'source-workspace';
let changed: () => void;
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  ...jest.requireActual('@/frontend/utils/workspaceSelection'),
  getSelectedWorkspace: () => selected,
  onWorkspaceChanged: (listener: () => void) => { changed = listener; return jest.fn(); },
}));
const fetchMock = jest.fn();
const originalFetch = global.fetch;
const transfer = 'recipient-transfer-passphrase';
const local = 'private-local-passphrase';
const transferField = () => screen.getByLabelText('Transfer passphrase (16+ characters)');
const localField = () => screen.getByLabelText('New workspace passphrase (12+ characters, different)');
function prepare() {
  fireEvent.change(transferField(), { target: { value: transfer } });
  fireEvent.click(screen.getByRole('checkbox'));
}
beforeEach(() => {
  jest.clearAllMocks(); selected = 'source-workspace'; global.fetch = fetchMock;
  URL.createObjectURL = jest.fn(() => 'blob:transfer'); URL.revokeObjectURL = jest.fn();
});
afterAll(() => { global.fetch = originalFetch; });

test('exports only after deliberate confirmation and clears passwords after failure without logging response details', async () => {
  fetchMock.mockResolvedValue({ ok: false });
  render(<CredentialTransferSettings />);
  const button = screen.getByRole('button', { name: 'Export encrypted credentials' });
  fireEvent.change(transferField(), { target: { value: transfer } });
  expect(button).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button);
  await screen.findByText(/Transfer failed/);
  expect(transferField()).toHaveValue('');
  expect(fetchMock.mock.calls[0][0]).toBe('/api/credential-transfer?workspace=source-workspace');
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ recipientPassphrase: transfer, confirmCredentialTransfer: true });
  expect(fetchMock.mock.calls[0][0]).not.toContain(transfer);
});

test('restore sends fresh namespace and distinct local passphrase in multipart body and clears both after success', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ workspace: 'new-workspace' }) });
  render(<CredentialTransferSettings />); prepare();
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['ciphertext'], 'private.flujo-transfer')] } });
  fireEvent.change(screen.getByLabelText('Unused destination workspace name'), { target: { value: 'new-workspace' } });
  fireEvent.change(localField(), { target: { value: transfer } });
  const button = screen.getByRole('button', { name: 'Restore into new private workspace' });
  expect(button).toBeDisabled();
  fireEvent.change(localField(), { target: { value: local } }); fireEvent.click(button);
  await screen.findByText(/Restored into new-workspace/);
  const form = fetchMock.mock.calls[0][1].body as FormData;
  expect(form.get('recipientPassphrase')).toBe(transfer); expect(form.get('localPassphrase')).toBe(local);
  expect(form.get('workspace')).toBe('new-workspace'); expect(form.get('confirmCredentialTransfer')).toBe('true');
  expect(transferField()).toHaveValue(''); expect(localField()).toHaveValue('');
});

test('workspace changes cancel a request, clear credentials and discard a late ciphertext download', async () => {
  let finish!: (value: unknown) => void;
  fetchMock.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  render(<CredentialTransferSettings />); prepare();
  fireEvent.click(screen.getByRole('button', { name: 'Export encrypted credentials' }));
  act(() => { selected = 'other-workspace'; changed(); });
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(transferField()).toHaveValue('');
  await act(async () => finish({ ok: true, blob: async () => new Blob(['ciphertext']) }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Export encrypted credentials' })).toBeDisabled());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
