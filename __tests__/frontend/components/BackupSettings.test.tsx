/** @jest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import BackupSettings from '@/frontend/components/Settings/BackupSettings';
jest.mock('@/frontend/components/Settings/PersonaRecoverySettings', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/Settings/CredentialTransferSettings', () => ({ __esModule: true, default: () => null }));
const originalFetch = global.fetch;
beforeEach(() => {
  URL.createObjectURL = jest.fn(() => 'blob:backup');
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
it.each(['partial', 'complete'])('downloads a %s archive with the correct visible outcome', async status => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: new Headers({ 'X-Flujo-Backup-Status': status }), blob: async () => new Blob(['archive']) });
  render(<BackupSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Create backup' }));
  if (status === 'partial') {
    expect(await screen.findByText(/Partial backup downloaded/)).toBeInTheDocument();
    expect(screen.queryByText('Backup created successfully.')).not.toBeInTheDocument();
  } else expect(await screen.findByText('Backup created successfully.')).toBeInTheDocument();
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:backup');
});
