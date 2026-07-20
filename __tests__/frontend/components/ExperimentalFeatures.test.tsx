/**
 * Component tests for the Experimental Features feature (issue #184).
 *
 * Covers the two deterministically-checkable behaviours:
 *  - Navigation hides the "Waves" entry when experimental features are
 *    disabled/undefined (and while settings are not yet hydrated), and shows it
 *    once experimental features are enabled.
 *  - The ExperimentalFeaturesSettings toggle calls updateSettings with the
 *    correctly merged payload.
 */
import { render, screen, fireEvent } from '@testing-library/react';

// --- Shared useStorage mock (configured per-test) -------------------------
const mockUpdateSettings = jest.fn();
let mockStorageValue: any = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorageValue,
}));

// Navigation-only external deps — irrelevant to the visibility assertions.
jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ toggleTheme: jest.fn(), isDarkMode: false }),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/frontend/utils/navigationGuard', () => ({
  interceptNavigation: () => false,
}));
jest.mock('@/frontend/components/BugReport/BugReportButton', () => ({
  __esModule: true,
  default: () => null,
}));

import Navigation from '@/frontend/components/Navigation';
import ExperimentalFeaturesSettings from '@/frontend/components/Settings/ExperimentalFeaturesSettings';

describe('Navigation experimental gating (#184)', () => {
  beforeEach(() => {
    mockUpdateSettings.mockClear();
  });

  it('hides the Waves entry when experimental features are disabled/undefined', () => {
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);
    expect(screen.queryByText('Waves')).not.toBeInTheDocument();
    // Non-experimental items still render.
    expect(screen.getByText('Flows')).toBeInTheDocument();
  });

  it('hides the Waves entry while settings are not yet hydrated even if enabled', () => {
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: false,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);
    expect(screen.queryByText('Waves')).not.toBeInTheDocument();
  });

  it('shows the Waves entry when experimental features are enabled', () => {
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);
    expect(screen.getByText('Waves')).toBeInTheDocument();
  });
});

describe('ExperimentalFeaturesSettings toggle (#184)', () => {
  beforeEach(() => {
    mockUpdateSettings.mockClear();
  });

  it('defaults to off (unchecked) when no experimental setting exists', () => {
    mockStorageValue = { settings: { speech: { enabled: true } }, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<ExperimentalFeaturesSettings />);
    const toggle = screen.getByRole('checkbox', { name: /Enable Experimental Features/i });
    expect(toggle).not.toBeChecked();
  });

  it('calls updateSettings with a merged payload enabling experimental features', () => {
    mockStorageValue = { settings: { speech: { enabled: true } }, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<ExperimentalFeaturesSettings />);
    const toggle = screen.getByRole('checkbox', { name: /Enable Experimental Features/i });
    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: { enabled: true },
    });
  });
});
