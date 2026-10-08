import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CredentialMigrationRecovery from '@/frontend/components/CredentialMigrationRecovery';
import EncryptionAuthDialog from '@/frontend/components/EncryptionAuthDialog';

const mockVerify = jest.fn();
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({ verifyKey: mockVerify }) }));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/utils/encryptionLock', () => ({
  installEncryptionLockInterceptor: jest.fn(), ENCRYPTION_LOCKED_EVENT: 'fixture-locked',
  ENCRYPTION_UNLOCKED_EVENT: 'fixture-unlocked',
}));
const savedFetch = global.fetch;
let mockFetch: jest.Mock;
function response(body: unknown, ok = true) { return { ok, json: async () => body } as Response; }
beforeEach(() => {
  mockVerify.mockReset().mockResolvedValue(true);
  mockFetch = jest.fn().mockResolvedValue(response({ initialized: false, locked: true, protection: 'uninitialized' }));
  global.fetch = mockFetch;
  sessionStorage.clear();
});
afterEach(() => { global.fetch = savedFetch; });
async function setup() {
  render(<EncryptionAuthDialog />);
  return await screen.findByLabelText('settings.encryption.newPassword');
}
test('fresh stores show passphrase setup without requesting default encryption', async () => {
  await setup();
  expect(screen.getByLabelText('settings.encryption.confirmPassword')).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ action: 'status' });
});
test('setup rejects short or mismatched confirmation before sending a passphrase', async () => {
  const password = await setup();
  fireEvent.change(password, { target: { value: 'short' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.setAction' }));
  expect(await screen.findByText('settings.encryption.minLength')).toBeInTheDocument();
  fireEvent.change(password, { target: { value: 'long-owner-passphrase' } });
  fireEvent.change(screen.getByLabelText('settings.encryption.confirmPassword'), { target: { value: 'different' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.setAction' }));
  expect(await screen.findByText('settings.encryption.mismatch')).toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test('setup initializes then unlocks and broadcasts reload without storing the passphrase', async () => {
  const password = await setup();
  const storage = jest.spyOn(Storage.prototype, 'setItem');
  const unlocked = jest.fn(); window.addEventListener('fixture-unlocked', unlocked);
  mockFetch.mockResolvedValueOnce(response({ success: true }));
  fireEvent.change(password, { target: { value: 'long-owner-passphrase' } });
  fireEvent.change(screen.getByLabelText('settings.encryption.confirmPassword'), { target: { value: 'long-owner-passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.setAction' }));
  await waitFor(() => expect(mockVerify).toHaveBeenCalledWith('long-owner-passphrase'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ action: 'initialize', password: 'long-owner-passphrase' });
  expect(storage).not.toHaveBeenCalled(); expect(unlocked).toHaveBeenCalledTimes(1);
  window.removeEventListener('fixture-unlocked', unlocked); storage.mockRestore();
});
test('failed setup ignores raw diagnostics, clears both password fields and retains setup', async () => {
  const password = await setup();
  mockFetch.mockResolvedValueOnce(response({ error: 'private-server-secret' }, false));
  fireEvent.change(password, { target: { value: 'long-owner-passphrase' } });
  fireEvent.change(screen.getByLabelText('settings.encryption.confirmPassword'), { target: { value: 'long-owner-passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.setAction' }));
  expect(await screen.findByText('encryption.unlock.error')).toBeInTheDocument();
  expect(password).toHaveValue('');
  expect(screen.getByLabelText('settings.encryption.confirmPassword')).toHaveValue('');
  expect(screen.queryByText('private-server-secret')).not.toBeInTheDocument();
  expect(mockVerify).not.toHaveBeenCalled();
});
test('a browser authentication flag cannot hide a server lock after restart', async () => {
  sessionStorage.setItem('encryption_authenticated', 'true');
  mockFetch.mockResolvedValue(response({ initialized: true, locked: true, protection: 'passphrase' }));
  render(<EncryptionAuthDialog />);
  expect(await screen.findByLabelText('encryption.unlock.password')).toBeInTheDocument();
});
test('operator mount failure gives operator remediation and disables browser password attempts', async () => {
  mockFetch.mockResolvedValue(response({ initialized: true, locked: true, protection: 'operator-file' }));
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.operator.unavailable')).toBeInTheDocument();
  expect(screen.getByLabelText('encryption.unlock.password')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'encryption.unlock.action' })).toBeDisabled();
  expect(mockVerify).not.toHaveBeenCalled();
});
test('a missing first-start operator mount does not offer a passphrase downgrade', async () => {
  mockFetch.mockResolvedValue(response({ initialized: false, locked: true, protection: 'operator-file' }));
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.operator.unavailable')).toBeInTheDocument();
  expect(screen.queryByLabelText('settings.encryption.newPassword')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'encryption.unlock.action' })).toBeDisabled();
});
test('unlocked operator and existing legacy profiles remain usable', async () => {
  mockFetch.mockResolvedValue(response({ initialized: true, locked: false, protection: 'operator-file' }));
  const { unmount } = render(<EncryptionAuthDialog />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); unmount();
  mockFetch.mockResolvedValue(response({ initialized: true, locked: false, protection: 'legacy-default' }));
  render(<EncryptionAuthDialog />);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
test('unavailable status does not report the browser as unlocked', async () => {
  mockFetch.mockResolvedValue(response({ error: 'private-status-diagnostic' }, false));
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.unlock.error')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByText('private-status-diagnostic')).not.toBeInTheDocument();
});

const pending = { initialized: true, locked: true, protection: 'migration-pending' };
async function recovery() {
  mockFetch.mockResolvedValue(response(pending));
  render(<EncryptionAuthDialog />);
  return screen.findByLabelText('encryption.recovery.passphrase');
}
function confirmRecovery(field: HTMLElement) {
  fireEvent.change(field, { target: { value: 'private-recovery-passphrase' } });
  fireEvent.click(screen.getByRole('checkbox'));
}
test('pending migration never offers ordinary setup or unlock and requires explicit confirmation', async () => {
  const field = await recovery();
  expect(screen.queryByLabelText('encryption.unlock.password')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('settings.encryption.newPassword')).not.toBeInTheDocument();
  fireEvent.change(field, { target: { value: 'private-recovery-passphrase' } });
  expect(screen.getByRole('button', { name: 'encryption.recovery.resume' })).toBeDisabled();
  expect(mockVerify).not.toHaveBeenCalled();
});
test.each(['resume', 'rollback'])('confirmed %s sends only explicit recovery and rereads locked status', async action => {
  const field = await recovery(); const unlocked = jest.fn();
  window.addEventListener('fixture-unlocked', unlocked);
  mockFetch.mockResolvedValueOnce(response({ status: action === 'resume' ? 'committed' : 'rolled-back' }))
    .mockResolvedValueOnce(response({ initialized: true, locked: true, protection: 'passphrase' }));
  confirmRecovery(field);
  fireEvent.click(screen.getByRole('button', { name: `encryption.recovery.${action}` }));
  expect(await screen.findByLabelText('encryption.unlock.password')).toHaveValue('');
  expect(mockFetch.mock.calls[1][0]).toBe('/api/credential-migration?workspace=default-workspace');
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ action, recoveryPassphrase: 'private-recovery-passphrase', confirmMigration: true });
  expect(mockVerify).not.toHaveBeenCalled(); expect(unlocked).not.toHaveBeenCalled();
  window.removeEventListener('fixture-unlocked', unlocked);
});
test('failed recovery keeps pending controls, clears secrets and ignores server diagnostics', async () => {
  const field = await recovery();
  mockFetch.mockResolvedValueOnce(response({ error: 'private-server-secret' }, false));
  confirmRecovery(field); fireEvent.click(screen.getByRole('button', { name: 'encryption.recovery.resume' }));
  expect(await screen.findByText('encryption.recovery.failed')).toBeInTheDocument();
  await waitFor(() => expect(field).toHaveValue(''));
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(screen.queryByText('private-server-secret')).not.toBeInTheDocument();
});
test('cancel aborts the request, clears the passphrase and rereads pending state without retrying', async () => {
  const field = await recovery();
  mockFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  confirmRecovery(field); fireEvent.click(screen.getByRole('button', { name: 'encryption.recovery.resume' }));
  fireEvent.click(await screen.findByRole('button', { name: 'encryption.recovery.cancel' }));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
  expect(field).toHaveValue(''); expect(mockFetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(mockVerify).not.toHaveBeenCalled();
});
test('stale unlocked status cannot dismiss a newer pending status', async () => {
  let resolve!: (value: Response) => void;
  mockFetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }))
    .mockResolvedValueOnce(response(pending));
  render(<EncryptionAuthDialog />);
  fireEvent(window, new CustomEvent('fixture-locked'));
  expect(await screen.findByLabelText('encryption.recovery.passphrase')).toBeInTheDocument();
  resolve(response({ initialized: true, locked: false, protection: 'passphrase' }));
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
});
test('double Enter admits only one unlock mutation', async () => {
  mockFetch.mockResolvedValue(response({ initialized: true, locked: true, protection: 'passphrase' }));
  mockVerify.mockImplementation(() => new Promise(() => {}));
  render(<EncryptionAuthDialog />);
  const field = await screen.findByLabelText('encryption.unlock.password');
  fireEvent.change(field, { target: { value: 'private-owner-passphrase' } });
  fireEvent.keyDown(field, { key: 'Enter' }); fireEvent.keyDown(field, { key: 'Enter' });
  expect(mockVerify).toHaveBeenCalledTimes(1);
});

test('recovery teardown aborts and discards the late result from the previous workspace', async () => {
  let resolve!: (value: Response) => void;
  const settled = jest.fn().mockResolvedValue(undefined);
  mockFetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const { rerender } = render(<CredentialMigrationRecovery workspace="source" onSettled={settled} />);
  confirmRecovery(screen.getByLabelText('encryption.recovery.passphrase'));
  fireEvent.click(screen.getByRole('button', { name: 'encryption.recovery.resume' }));
  rerender(<CredentialMigrationRecovery workspace="destination" onSettled={settled} />);
  expect(mockFetch.mock.calls[0][0]).toBe('/api/credential-migration?workspace=source');
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(screen.getByLabelText('encryption.recovery.passphrase')).toHaveValue('');
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  resolve(response({ status: 'committed' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'encryption.recovery.resume' })).toBeDisabled());
  expect(settled).not.toHaveBeenCalled();
});
