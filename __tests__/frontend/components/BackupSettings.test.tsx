/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

it.each(['partial', 'failed', 'empty'])('retains the upload after a %s restore and allows retry', async status => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: status === 'partial', json: async () => ({ success: false, status, selectionResults: { models: { restored: 0, failed: 1 } } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'complete' }) });
  const { container } = render(<BackupSettings />);
  const file = new File(['archive'], 'my-backup.zip', { type: 'application/zip' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Restore from backup' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore from backup' })).toBeEnabled());
  expect(screen.getByText('Selected file: my-backup.zip')).toBeInTheDocument();
  expect(screen.queryByText(/Restore completed successfully/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore from backup' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
  expect(await screen.findByText(/Restore completed successfully/)).toBeInTheDocument();
  expect(screen.queryByText('Selected file: my-backup.zip')).not.toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

it.each(['network', 'non-JSON'])('retains the upload after a %s error and allows retry', async kind => {
  const fetchMock = jest.fn();
  if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
  else fetchMock.mockResolvedValueOnce({ ok: false, json: async () => { throw new SyntaxError('HTML response'); } });
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'complete' }) });
  global.fetch = fetchMock;
  render(<BackupSettings />);
  fireEvent.change(screen.getByLabelText('Select backup file'), { target: { files: [new File(['archive'], 'retry.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Restore from backup' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
  expect(await screen.findByText(/Restore failed\. Check your backup/)).toBeInTheDocument();
  expect(screen.getByText('Selected file: retry.zip')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore from backup' })).toBeEnabled());
  expect(screen.getByText(/Restore failed\. Check your backup/).closest('[role="alert"]')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Restore from backup' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
  expect(await screen.findByText(/Restore completed successfully/)).toBeInTheDocument();
});
