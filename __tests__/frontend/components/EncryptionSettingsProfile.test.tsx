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

test('fresh private setup remains available without legacy migration', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: false, locked: true, protection: 'uninitialized' }) });
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
