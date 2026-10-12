import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CredentialMigrationSettings from '@/frontend/components/Settings/CredentialMigrationSettings';

jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/utils/workspaceSelection', () => ({
  getSelectedWorkspace: () => 'mounted-source',
  withWorkspaceUrl: (url: string, workspace: string) => `${url}?workspace=${workspace}`,
}));
jest.mock('@/frontend/utils/encryptionLock', () => ({ ENCRYPTION_LOCKED_EVENT: 'fixture-locked' }));
const savedFetch = global.fetch;
let mockFetch: jest.Mock;
const plan = { planToken: 'a'.repeat(64), protection: 'passphrase', retireActiveKey: false, activeKeyWillChange: false, stores: [{ store: 'models', credentials: 3 }] };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
beforeEach(() => { mockFetch = jest.fn().mockResolvedValue(response(plan)); global.fetch = mockFetch; });
afterEach(() => { global.fetch = savedFetch; });
function fill() {
  fireEvent.change(screen.getByLabelText('settings.migration.source'), { target: { value: 'source-private-passphrase' } });
  fireEvent.change(screen.getByLabelText('encryption.recovery.passphrase'), { target: { value: 'recovery-private-passphrase' } });
  fireEvent.change(screen.getByLabelText('settings.migration.confirmPassphrase'), { target: { value: 'recovery-private-passphrase' } });
}
async function preflight() {
  render(<CredentialMigrationSettings />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await screen.findByText('settings.migration.inventory');
}
test('preflight authenticates explicit private inputs without mutation or exposing Source fields', async () => {
  await preflight();
  expect(mockFetch.mock.calls[0][0]).toBe('/api/credential-migration?workspace=mounted-source');
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ action: 'preflight', sourcePassphrase: 'source-private-passphrase',
    recoveryPassphrase: 'recovery-private-passphrase', protection: 'passphrase', retireActiveKey: false });
  expect(screen.getByRole('button', { name: 'settings.migration.migrate' })).toBeDisabled();
});
test('passphrase mismatch prevents requests', () => {
  render(<CredentialMigrationSettings />); fill();
  fireEvent.change(screen.getByLabelText('settings.migration.confirmPassphrase'), { target: { value: 'mismatched' } });
  expect(screen.getByRole('button', { name: 'settings.migration.preflight' })).toBeDisabled();
  expect(mockFetch).not.toHaveBeenCalled();
});
test('editing a private input invalidates the reviewed plan and confirmation', async () => {
  await preflight();
  fireEvent.click(screen.getByLabelText('settings.migration.confirm'));
  fireEvent.change(screen.getByLabelText('settings.migration.source'), { target: { value: 'changed' } });
  expect(screen.queryByRole('button', { name: 'settings.migration.migrate' })).not.toBeInTheDocument();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test('confirmed migration binds the reviewed plan, clears secrets and signals lock status rather than unlock', async () => {
  await preflight();
  const locked = jest.fn(); window.addEventListener('fixture-locked', locked);
  const storage = jest.spyOn(Storage.prototype, 'setItem');
  mockFetch.mockResolvedValueOnce(response({ status: 'committed' }));
  fireEvent.click(screen.getByLabelText('settings.migration.confirm'));
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.migrate' }));
  await screen.findByText('settings.migration.done');
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toMatchObject({ action: 'migrate', planToken: plan.planToken, confirmMigration: true });
  expect(screen.getByLabelText('settings.migration.source')).toHaveValue('');
  expect(screen.getByLabelText('encryption.recovery.passphrase')).toHaveValue('');
  expect(screen.getByLabelText('settings.migration.confirmPassphrase')).toHaveValue('');
  expect(locked).toHaveBeenCalledTimes(1); expect(storage).not.toHaveBeenCalled();
  window.removeEventListener('fixture-locked', locked); storage.mockRestore();
});
test('operator target is an explicit choice and invalidates the old plan', async () => {
  await preflight(); fireEvent.click(screen.getByLabelText('settings.migration.operator'));
  expect(screen.queryByText('settings.migration.inventory')).not.toBeInTheDocument();
  mockFetch.mockResolvedValueOnce(response({ ...plan, protection: 'operator-file' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await screen.findByText('settings.migration.inventory');
  expect(JSON.parse(mockFetch.mock.calls[1][1].body).protection).toBe('operator-file');
});

test('explicit key retirement invalidates the plan and displays the reviewed key replacement', async () => {
  await preflight();
  fireEvent.click(screen.getByLabelText('settings.migration.confirm'));
  fireEvent.click(screen.getByLabelText('settings.migration.retireKey'));
  expect(screen.queryByText('settings.migration.inventory')).not.toBeInTheDocument();
  mockFetch.mockResolvedValueOnce(response({ ...plan, retireActiveKey: true, activeKeyWillChange: true }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await screen.findByText('settings.migration.keyReplaced');
  expect(JSON.parse(mockFetch.mock.calls[1][1].body).retireActiveKey).toBe(true);
  expect(screen.getByRole('button', { name: 'settings.migration.migrate' })).toBeDisabled();
});

test('retirement preflight cannot substitute a retained active key', async () => {
  render(<CredentialMigrationSettings />); fill();
  fireEvent.click(screen.getByLabelText('settings.migration.retireKey'));
  mockFetch.mockResolvedValueOnce(response({ ...plan, retireActiveKey: true, activeKeyWillChange: false }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await screen.findByText('settings.migration.failed');
  expect(screen.queryByRole('button', { name: 'settings.migration.migrate' })).not.toBeInTheDocument();
});
test.each([response({ error: 'private-server-secret' }, false), response({ ...plan, stores: [{ store: 'private-server-secret', credentials: 1 }] })])
('failure and invalid inventory use fixed remediation and clear all passphrases', async reply => {
  mockFetch.mockResolvedValueOnce(reply); render(<CredentialMigrationSettings />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await screen.findByText('settings.migration.failed');
  expect(screen.queryByText('private-server-secret')).not.toBeInTheDocument();
  expect(screen.getByLabelText('settings.migration.source')).toHaveValue('');
  expect(screen.getByLabelText('encryption.recovery.passphrase')).toHaveValue('');
});
test('cancelling an admitted mutation aborts and requests fresh lock state without retry', async () => {
  await preflight(); const locked = jest.fn(); window.addEventListener('fixture-locked', locked);
  mockFetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  fireEvent.click(screen.getByLabelText('settings.migration.confirm'));
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.migrate' }));
  fireEvent.click(await screen.findByRole('button', { name: 'encryption.recovery.cancel' }));
  await waitFor(() => expect(locked).toHaveBeenCalledTimes(1));
  expect(mockFetch).toHaveBeenCalledTimes(2); expect(mockFetch.mock.calls[1][1].signal.aborted).toBe(true);
  expect(screen.getByLabelText('encryption.recovery.passphrase')).toHaveValue('');
  window.removeEventListener('fixture-locked', locked);
});
test('teardown aborts the mounted workspace request and ignores its late result', async () => {
  let resolve!: (value: Response) => void;
  mockFetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const { unmount } = render(<CredentialMigrationSettings />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  unmount(); expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  resolve(response(plan));
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
});

test('a rejected preflight requests fresh lock status so pending migration opens recovery', async () => {
  const locked = jest.fn(); window.addEventListener('fixture-locked', locked);
  mockFetch.mockResolvedValueOnce(response({ error: 'MIGRATION_PENDING' }, false));
  render(<CredentialMigrationSettings />); fill();
  fireEvent.click(screen.getByRole('button', { name: 'settings.migration.preflight' }));
  await waitFor(() => expect(locked).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: 'settings.migration.migrate' })).not.toBeInTheDocument();
  window.removeEventListener('fixture-locked', locked);
});
