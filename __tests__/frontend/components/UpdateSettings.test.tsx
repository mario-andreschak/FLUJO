import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import UpdateSettings from '@/frontend/components/Settings/UpdateSettings';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: { update: { checkOnStartup: false } }, updateSettings: jest.fn() }),
}));

const originalFetch = global.fetch;
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; });

describe('update eligibility', () => {
  it('requires a successful update check before enabling Update now', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({
      success: true, isGitRepo: true, updateMode: 'git', canApply: true, updateAvailable: true, behindBy: 2, branch: 'main',
    }) });
    render(<UpdateSettings />);
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled());
  });

  it('shows pinned release identity and newer-installer guidance instead of offering a branch update', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({
      success: true, isGitRepo: true, updateMode: 'pinned', canApply: false, updateAvailable: false,
      sourceRef: 'v3.45.2', revision: 'abcdef1234567890',
    }) });
    render(<UpdateSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('newer versioned FLUJO installer');
    expect(screen.getByText(/Installed source:/)).toHaveTextContent('v3.45.2 · abcdef123456');
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Get a newer installer' })).toHaveAttribute('href', 'https://github.com/mario-andreschak/FLUJO/releases/latest');
  });

  it('disables a previously available update when the server detects new local edits', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, isGitRepo: true, updateMode: 'git', canApply: true, updateAvailable: true, behindBy: 1, branch: 'main' }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, updateMode: 'blocked', error: 'Back up your local edits before updating.' }) });
    render(<UpdateSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Back up your local edits'));
    expect(screen.getByRole('button', { name: 'Update now' })).toBeDisabled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
