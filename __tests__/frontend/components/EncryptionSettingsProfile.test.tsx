import { render, screen } from '@testing-library/react';
import EncryptionSettings from '@/frontend/components/Settings/EncryptionSettings';

const mockT = (key: string) => key;
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => ({
  setKey: jest.fn(), changeKey: jest.fn(), verifyKey: jest.fn(),
}) }));
const savedFetch = global.fetch;
afterEach(() => { global.fetch = savedFetch; });
test('operator profile is labeled separately and offers no browser passphrase replacement', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: true, locked: false, protection: 'operator-file' }) });
  render(<EncryptionSettings />);
  expect(await screen.findByText('settings.encryption.statusOperator')).toBeInTheDocument();
  expect(screen.getByText('settings.encryption.operatorHelp')).toBeInTheDocument();
  expect(screen.queryByLabelText('settings.encryption.newPassword')).not.toBeInTheDocument();
  expect(screen.queryByText('settings.encryption.statusDefault')).not.toBeInTheDocument();
});
test('legacy metadata directs the owner to full migration and offers no metadata-only password upgrade', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: true, locked: false, protection: 'legacy-default' }) });
  render(<EncryptionSettings />);
  expect(await screen.findByText('settings.encryption.statusDefault')).toBeInTheDocument();
  expect(screen.getByText('settings.encryption.migrationRequired')).toBeInTheDocument();
  expect(screen.getByText('settings.migration.title')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'settings.migration.preflight' })).toBeInTheDocument();
  expect(screen.queryByLabelText('settings.encryption.newPassword')).not.toBeInTheDocument();
});

test('optional custom password setup remains available in Settings for a fresh unlocked workspace', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: false, locked: false, protection: 'uninitialized' }) });
  render(<EncryptionSettings />);
  expect(await screen.findByLabelText('settings.encryption.newPassword')).toBeInTheDocument();
  expect(screen.queryByText('settings.encryption.migrationRequired')).not.toBeInTheDocument();
  expect(screen.queryByText('settings.migration.title')).not.toBeInTheDocument();
});

test('private password changes remain available alongside optional retirement migration', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: true, locked: true, protection: 'passphrase' }) });
  render(<EncryptionSettings />);
  expect(await screen.findByText('settings.encryption.statusCustom')).toBeInTheDocument();
  expect(screen.getByLabelText('settings.encryption.currentPassword')).toBeInTheDocument();
  expect(screen.getByText('settings.migration.title')).toBeInTheDocument();
  expect(screen.queryByText('settings.encryption.migrationRequired')).not.toBeInTheDocument();
});

describe('system key protection (#1443)', () => {
  const systemKey = { available: 'windows', keptIn: 'windows', recoveryKeySaved: false, problem: null, retryAt: null };
  function serve(status: Record<string, unknown>) {
    const calls: Array<{ url: string; body: unknown }> = [];
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).includes('/api/encryption/system-key')) {
        return { ok: true, json: async () => body.action === 'reveal' ? { recoveryKey: 'RECOVERY-key_0123456789abcdefghijklmnopqrstuvwx' } : { saved: true } };
      }
      return { ok: true, json: async () => status };
    });
    return calls;
  }

  test('shows the protection, the recovery key and remembers that it was saved; no public-password warning', async () => {
    const calls = serve({ initialized: true, locked: false, protection: 'os-store', systemKey });
    render(<EncryptionSettings />);
    expect(await screen.findByText('settings.systemKey.status')).toBeInTheDocument();
    expect(screen.getByText('settings.systemKey.help')).toBeInTheDocument();
    expect(screen.getByText('settings.systemKey.recoveryNotSaved')).toBeInTheDocument();
    expect(screen.queryByText('settings.encryption.migrationRequired')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.encryption.default1', { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('settings.encryption.newPassword')).not.toBeInTheDocument();
    expect(screen.getByText('settings.migration.title')).toBeInTheDocument();

    screen.getByRole('button', { name: 'settings.systemKey.show' }).click();
    expect(await screen.findByDisplayValue('RECOVERY-key_0123456789abcdefghijklmnopqrstuvwx')).toBeInTheDocument();
    expect(calls.find(call => call.url.includes('/api/encryption/system-key'))?.body).toEqual({ action: 'reveal' });

    screen.getByRole('button', { name: 'settings.systemKey.markSaved' }).click();
    expect(await screen.findByText('settings.systemKey.recoverySaved')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('RECOVERY-key_0123456789abcdefghijklmnopqrstuvwx')).not.toBeInTheDocument();
  });

  test('explains plainly when the store does not answer, without offering the recovery key panel', async () => {
    serve({ initialized: true, locked: true, protection: 'os-store',
      systemKey: { ...systemKey, problem: 'Windows did not hand over FLUJO\'s key just now.' } });
    render(<EncryptionSettings />);
    expect(await screen.findByText(/settings.systemKey.locked/)).toHaveTextContent('Windows did not hand over FLUJO\'s key just now.');
    expect(screen.queryByRole('button', { name: 'settings.systemKey.show' })).not.toBeInTheDocument();
  });

  test('says the move is automatic while a default workspace waits for it, and warns where no store exists', async () => {
    serve({ initialized: true, locked: false, protection: 'legacy-default', systemKey: { ...systemKey, keptIn: null } });
    const { unmount } = render(<EncryptionSettings />);
    expect(await screen.findByText('settings.systemKey.movePending')).toBeInTheDocument();
    unmount();
    serve({ initialized: true, locked: false, protection: 'legacy-default' });
    render(<EncryptionSettings />);
    expect(await screen.findByText('settings.systemKey.unavailableHere')).toBeInTheDocument();
  });
});
