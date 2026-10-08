import { render, screen, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
let mockStorageValue: {
  settings: { experimental?: { enabled?: boolean } };
  settingsHydrated: boolean;
};

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorageValue,
}));

jest.mock('@/frontend/components/Statistics', () => ({
  __esModule: true,
  default: () => <div>Statistics dashboard content</div>,
}));

import StatisticsPage from '@/app/statistics/page';

describe('Statistics experimental route guard', () => {
  beforeEach(() => {
    mockReplace.mockClear();
  });

  it('keeps the dashboard hidden while settings hydrate', () => {
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: false,
    };

    render(<StatisticsPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Statistics dashboard content')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('redirects a disabled deep link to settings', async () => {
    mockStorageValue = {
      settings: { experimental: { enabled: false } },
      settingsHydrated: true,
    };

    render(<StatisticsPage />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Statistics dashboard content')).not.toBeInTheDocument();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/settings'));
  });

  it('renders the dashboard only when experimental features are enabled', () => {
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
    };

    render(<StatisticsPage />);

    expect(screen.getByText('Statistics dashboard content')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
