/**
 * Component tests for the Experimental Features feature (issue #184).
 *
 * Covers the two deterministically-checkable behaviours:
 *  - The setup-first primary navigation remains small and ordered, while
 *    secondary/experimental destinations stay inside More.
 *  - The ExperimentalFeaturesSettings toggle calls updateSettings with the
 *    correctly merged payload.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';

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

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: () => ({
    open: false,
    openDock: jest.fn(),
    closeDock: jest.fn(),
    toggleDock: jest.fn(),
    getPageContext: jest.fn(),
    applyPageAction: jest.fn(),
    registerPage: jest.fn(() => jest.fn()),
  }),
  useAskFlujoPage: jest.fn(() => null),
}));

import Navigation from '@/frontend/components/Navigation';
import ExperimentalFeaturesSettings from '@/frontend/components/Settings/ExperimentalFeaturesSettings';

describe('setup-first navigation and experimental gating (#184, #325)', () => {
  beforeEach(() => {
    mockUpdateSettings.mockClear();
    mockPathname = '/';
  });

  it('orders the primary navigation around the required setup journey', () => {
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const primaryNavigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    const primaryLinks = within(primaryNavigation).getAllByRole('link');

    expect(primaryLinks.map((link) => link.textContent?.trim())).toEqual([
      'AI Setup',
      'Connected Apps',
      'Agents',
      'Talk',
      'More',
    ]);
    expect(primaryLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/models',
      '/mcp',
      '/flows',
      '/chat',
      '/automation/triggers',
    ]);
    expect(within(primaryNavigation).getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/flows');
  });

  it('keeps every requested More destination available before settings hydrate', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: false,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
      'href',
      '/automation/triggers',
    );
    expect(within(moreSections).getByRole('tab', { name: 'Help' })).toHaveAttribute('href', '/docs');
    expect(within(moreSections).getByRole('tab', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(within(moreSections).getByRole('tab', { name: 'Extensions' })).toHaveAttribute('href', '/packages');
    expect(within(moreSections).getByRole('tab', { name: 'Activity' })).toHaveAttribute('href', '/statistics');
  });

  it('puts Automations, Extensions, Activity, Help, and Settings in More when experiments are enabled', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const tabs = within(moreSections).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Automations',
      'Extensions',
      'Activity',
      'Help',
      'Settings',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/automation/triggers',
      '/packages',
      '/statistics',
      '/docs',
      '/settings',
    ]);
    expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
      'aria-selected',
      'true',
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

  it('defaults MCP App click gating and MCP roots confinement to off', () => {
    mockStorageValue = {
      settings: { speech: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    expect(screen.getByRole('checkbox', {
      name: /Require a click to open allowed MCP Apps/i,
    })).not.toBeChecked();
    expect(screen.getByRole('checkbox', {
      name: /Restrict MCP filesystem access to configured roots/i,
    })).not.toBeChecked();
  });

  it('persists both optional restrictions without dropping other settings', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    fireEvent.click(screen.getByRole('checkbox', {
      name: /Require a click to open allowed MCP Apps/i,
    }));
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        requireMcpAppLaunchClick: true,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', {
      name: /Restrict MCP filesystem access to configured roots/i,
    }));
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        restrictMcpFilesystemToRoots: true,
      },
    });
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
