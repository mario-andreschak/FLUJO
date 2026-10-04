import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { EncryptionStatus } from '@/shared/types/encryption';
import EncryptionAuthDialog from '@/frontend/components/EncryptionAuthDialog';

const mockStatus = jest.fn<Promise<EncryptionStatus>, []>();
const mockSetKey = jest.fn<Promise<void>, [string]>();
const mockVerify = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ getEncryptionStatus: mockStatus, setKey: mockSetKey, verifyKey: mockVerify }),
}));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('@/frontend/utils/encryptionLock', () => ({ installEncryptionLockInterceptor: jest.fn(),
  ENCRYPTION_LOCKED_EVENT: 'flujo:encryption-locked', ENCRYPTION_UNLOCKED_EVENT: 'flujo:encryption-unlocked' }));

const fresh: EncryptionStatus = { initialized: false, type: null, locked: true, recoveryRequired: false, protection: 'interactive' };
const operatorLocked: EncryptionStatus = { initialized: true, type: 'user', locked: true, recoveryRequired: false, protection: 'operator' };
const password = 'synthetic-private-ui-passphrase';
beforeEach(() => {
  mockStatus.mockReset().mockResolvedValue(fresh);
  mockSetKey.mockReset().mockResolvedValue(undefined);
  mockVerify.mockReset().mockResolvedValue(true);
  sessionStorage.clear();
});

async function fillSetup(confirmation = password): Promise<void> {
  const field = await screen.findByLabelText('encryption.unlock.password');
  fireEvent.change(field, { target: { value: password } });
  fireEvent.change(screen.getByLabelText('settings.encryption.confirmPassword'), { target: { value: confirmation } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.setAction' }));
}

test('fresh setup waits for durable initialization before unlock and clears the dialog', async () => {
  let acknowledge!: () => void;
  mockSetKey.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  render(<EncryptionAuthDialog />);
  await fillSetup();
  expect(mockSetKey).toHaveBeenCalledWith(password);
  expect(mockVerify).not.toHaveBeenCalled();
  await act(async () => acknowledge());
  await waitFor(() => expect(mockVerify).toHaveBeenCalledWith(password));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('a cached browser flag does not bypass a server lock', async () => {
  sessionStorage.setItem('encryption_authenticated', 'true');
  mockStatus.mockResolvedValue({ initialized: true, type: 'user', locked: true, recoveryRequired: false, protection: 'interactive' });
  render(<EncryptionAuthDialog />);
  expect(await screen.findByLabelText('encryption.unlock.password')).toBeInTheDocument();
  expect(screen.queryByLabelText('settings.encryption.confirmPassword')).not.toBeInTheDocument();
});

test('an unavailable operator file never requests its secret in the browser', async () => {
  mockStatus.mockResolvedValue(operatorLocked);
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.operator.unavailable')).toBeInTheDocument();
  expect(screen.queryByLabelText('encryption.unlock.password')).not.toBeInTheDocument();
  mockStatus.mockResolvedValue({ ...operatorLocked, locked: false });
  fireEvent.click(screen.getByRole('button', { name: 'encryption.status.retry' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mockSetKey).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});

test('unavailable status stays blocked and can recover into fresh setup', async () => {
  mockStatus.mockRejectedValue(new Error('synthetic status outage'));
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.status.unavailable')).toBeInTheDocument();
  expect(screen.queryByLabelText('encryption.unlock.password')).not.toBeInTheDocument();
  mockStatus.mockResolvedValue(fresh);
  fireEvent.click(screen.getByRole('button', { name: 'encryption.status.retry' }));
  expect(await screen.findByLabelText('settings.encryption.confirmPassword')).toBeInTheDocument();
});

test('mismatched setup confirmation never initializes or authenticates', async () => {
  render(<EncryptionAuthDialog />);
  await fillSetup('different-confirmation');
  expect(await screen.findByText('settings.encryption.mismatch')).toBeInTheDocument();
  expect(mockSetKey).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});

test('failed initialization retains setup and never authenticates a different key', async () => {
  mockSetKey.mockRejectedValue(new Error('synthetic write failure'));
  render(<EncryptionAuthDialog />);
  await fillSetup();
  expect(await screen.findByText('encryption.unlock.error')).toBeInTheDocument();
  expect(screen.getByLabelText('settings.encryption.confirmPassword')).toBeInTheDocument();
  expect(mockVerify).not.toHaveBeenCalled();
});

test('missing metadata beside credentials offers recovery instead of overwriting setup', async () => {
  mockStatus.mockResolvedValue({ ...fresh, recoveryRequired: true });
  render(<EncryptionAuthDialog />);
  expect(await screen.findByText('encryption.recovery.required')).toBeInTheDocument();
  expect(screen.queryByLabelText('encryption.unlock.password')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'settings.encryption.setAction' })).not.toBeInTheDocument();
  expect(mockSetKey).not.toHaveBeenCalled();
});
