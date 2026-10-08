import { render, screen, waitFor } from '@testing-library/react';
import PrivacySettings from '@/frontend/components/Settings/PrivacySettings';

const updateSettings = jest.fn();

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({
    settings: { speech: { enabled: true } },
    updateSettings,
  }),
}));

describe('PrivacySettings daily activity aggregate', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('shows today’s anonymous active installation count', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: '2026-07-29', count: 42 }),
    });

    render(<PrivacySettings />);

    await waitFor(() => {
      expect(
        screen.getByText('42 anonymous active installations today (UTC).'),
      ).toBeInTheDocument();
    });
  });

  it('shows a quiet unavailable state when the aggregate cannot be loaded', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    render(<PrivacySettings />);

    await waitFor(() => {
      expect(
        screen.getByText('Today’s anonymous activity count is currently unavailable.'),
      ).toBeInTheDocument();
    });
  });
});
