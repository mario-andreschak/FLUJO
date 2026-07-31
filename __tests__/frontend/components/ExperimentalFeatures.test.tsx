/**
 * Component tests for the Experimental Features feature (issue #184).
 *
 * Covers the two deterministically-checkable behaviours:
 *  - Navigation always shows Automation > Trigger as section tabs, hides the "Waves" tab
 *    when experimental features are disabled/undefined (and while settings are
 *    not yet hydrated), and shows it once experimental features are enabled.
 *  - The ExperimentalFeaturesSettings toggle calls updateSettings with the
 *    correctly merged payload.
 */
import { render, screen, fireEvent } from '@testing-library/react';

// --- Shared useStorage mock (configured per-test) -------------------------
const mockUpdateSettings = jest.fn();
let mockStorageValue: any = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
let mockPathname = '/';

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorageValue,
}));

// Navigation-only external deps — irrelevant to the visibility assertions.
jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ toggleTheme: jest.fn(), isDarkMode: false }),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
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

describe('Automation navigation and experimental gating (#184, #325)', () => {
  beforeEach(() => {
    mockUpdateSettings.mockClear();
    mockPathname = '/';
  });

  it('hides the Waves entry when experimental features are disabled/undefined', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);
    expect(screen.queryByText('Waves')).not.toBeInTheDocument();
    expect(screen.queryByText('Statistics')).not.toBeInTheDocument();
    expect(screen.getAllByText('Automation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Trigger').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: 'Trigger' })).toHaveAttribute(
      'href',
      '/automation/triggers'
    );
    // Non-experimental items still render.
    expect(screen.getAllByText('Flows').length).toBeGreaterThan(0);
  });

  it('hides the Waves entry while settings are not yet hydrated even if enabled', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: false,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);
    expect(screen.queryByText('Waves')).not.toBeInTheDocument();
    expect(screen.queryByText('Statistics')).not.toBeInTheDocument();
    expect(screen.getAllByText('Trigger').length).toBeGreaterThan(0);
  });

  it('shows the Waves entry when experimental features are enabled', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);
    expect(screen.getAllByText('Automation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Trigger').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waves').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Statistics').length).toBeGreaterThan(0);
    screen.getAllByRole('link', { name: 'Statistics' }).forEach((link) => {
      expect(link).toHaveAttribute('href', '/statistics');
    });
    expect(screen.getByRole('tab', { name: 'Waves' })).toHaveAttribute(
      'href',
      '/automation/waves'
    );
  });

  it('renders Automation as a primary link and its destinations as section tabs', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };

    render(<Navigation />);

    expect(screen.getByRole('link', { name: 'Automation' })).toHaveAttribute(
      'href',
      '/automation/triggers'
    );
    expect(screen.getByRole('tablist', { name: 'Automation sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trigger' })).toHaveAttribute(
      'href',
      '/automation/triggers'
    );
    expect(screen.getByRole('tab', { name: 'Waves' })).toHaveAttribute(
      'href',
      '/automation/waves'
    );
    expect(screen.getByRole('tab', { name: 'Trigger' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
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

  it('keeps the Flow-based generator off by default and persists its opt-in', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);
    const toggle = screen.getByRole('checkbox', { name: /Flow-based Flow Generator/i });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        flowBasedGenerator: true,
      },
    });
  });

  it('hides explicitly tool-less provider models by default and persists the reveal toggle', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);
    const toggle = screen.getByRole('checkbox', {
      name: /Show Models without tool capabilities/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        showModelsWithoutToolCapabilities: true,
      },
    });
  });

  it('defaults protected paths to off', () => {
    mockStorageValue = {
      settings: { speech: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);
    expect(
      screen.getByRole('checkbox', { name: /Protect sensitive home-directory paths/i })
    ).not.toBeChecked();
  });

  it('defaults filesystem snapshots to on', () => {
    mockStorageValue = {
      settings: { speech: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);
    expect(
      screen.getByRole('checkbox', { name: /Enable filesystem snapshots/i })
    ).toBeChecked();
  });

  it('persists disabling snapshots without dropping other settings', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Enable filesystem snapshots/i })
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        snapshotsEnabled: false,
      },
    });
  });

  it('persists the protected-path opt-in without dropping other settings', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Protect sensitive home-directory paths/i })
    );

    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        protectedPathsEnabled: true,
      },
    });
  });
});
