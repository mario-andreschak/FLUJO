import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NetworkExposureSettings from '@/frontend/components/Settings/NetworkExposureSettings';

const updateSettings = jest.fn();
let settingsValue: any = { speech: { enabled: true } };

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    settings: settingsValue,
    updateSettings,
  }),
}));

describe('NetworkExposureSettings', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    settingsValue = { speech: { enabled: true } };
    updateSettings.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: 'localhost', installMode: 'git' }),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('presents exactly the three exposure choices', async () => {
    render(<NetworkExposureSettings />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/network-exposure',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    expect(screen.getByRole('button', { name: 'Localhost' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Local Network' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Public' })).toBeInTheDocument();
  });

  it('persists one setting when Local Network is selected', () => {
    render(<NetworkExposureSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Local Network' }));

    expect(updateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      network: { exposure: 'network' },
    });
  });

  it('can persist a legacy-inferred mode without changing it', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: 'public', installMode: 'git' }),
    });
    render(<NetworkExposureSettings />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Public' })).toHaveAttribute('aria-pressed', 'true'));

    fireEvent.click(screen.getByRole('button', { name: 'Public' }));
    expect(updateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      network: { exposure: 'public' },
    });
  });

  it('shows the strong authentication warning for Public', () => {
    settingsValue = {
      speech: { enabled: true },
      network: { exposure: 'public' },
    };
    render(<NetworkExposureSettings />);

    expect(screen.getByText(/FLUJO has no built-in authentication/)).toBeInTheDocument();
  });
});
