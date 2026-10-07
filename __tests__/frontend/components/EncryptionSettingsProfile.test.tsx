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
test('legacy metadata is labeled as compatibility and keeps the explicit passphrase migration form', async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true,
    json: async () => ({ initialized: true, locked: false, protection: 'legacy-default' }) });
  render(<EncryptionSettings />);
  expect(await screen.findByText('settings.encryption.statusDefault')).toBeInTheDocument();
  expect(screen.getByText('settings.encryption.defaultHelp')).toBeInTheDocument();
  expect(screen.getByLabelText('settings.encryption.newPassword')).toBeInTheDocument();
});
