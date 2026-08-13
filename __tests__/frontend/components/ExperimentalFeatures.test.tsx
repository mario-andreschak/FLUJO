/**
 * Component tests for the Experimental Features feature (issue #184).
 *
 * Covers the two deterministically-checkable behaviours:
 *  - The setup-first primary navigation remains small and ordered, while
 *    secondary/experimental destinations stay inside More.
 *  - The ExperimentalFeaturesSettings toggle calls updateSettings with the
 *    correctly merged payload.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// --- Shared useStorage mock (configured per-test) -------------------------
const mockUpdateSettings = jest.fn();
let mockStorageValue: any = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
let mockPathname = '/';
const originalMatchMedia = window.matchMedia;

function setCompactNavigation(compact: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width:1279px)' ? compact : false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockStorageValue,
}));

// Navigation-only external deps — irrelevant to the visibility assertions.
jest.mock('@/frontend/contexts/ThemeContext', () => ({
  useTheme: () => ({ toggleTheme: jest.fn(), isDarkMode: false }),
}));
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  // #398: the navbar reads `?conversation=` to expose the open chat's magic link.
  useSearchParams: () => new URLSearchParams(),
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
    setCompactNavigation(false);
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
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

  it('keeps stable More destinations visible and hides experimental ones before settings hydrate', () => {
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
    expect(within(moreSections).getByRole('tab', { name: 'Roles' })).toHaveAttribute('href', '/roles');
    expect(within(moreSections).queryByRole('tab', { name: 'Personas' })).toBeNull();
    expect(within(moreSections).queryByRole('tab', { name: 'Waves' })).toBeNull();
    expect(within(moreSections).queryByRole('tab', { name: 'Chain Chat' })).toBeNull();
  });

  it('keeps Roles available and hides experimental Personas, Waves, and Chain Chat while experiments are off', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const tabs = within(moreSections).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/automation/triggers',
      '/meetings',
      '/roles',
      '/packages',
      '/statistics',
      '/docs',
      '/settings',
    ]);
    expect(within(moreSections).queryByRole('tab', { name: 'Personas' })).toBeNull();
    expect(within(moreSections).queryByRole('tab', { name: 'Waves' })).toBeNull();
    expect(within(moreSections).queryByRole('tab', { name: 'Chain Chat' })).toBeNull();
  });

  it.each(['/automation/waves', '/waves'])(
    'selects Waves in More when %s is open',
    (pathname) => {
      mockPathname = pathname;
      mockStorageValue = {
        settings: { experimental: { enabled: true } },
        settingsHydrated: true,
        updateSettings: mockUpdateSettings,
      };
      render(<Navigation />);

      const moreSections = screen.getByRole('tablist', { name: 'More sections' });
      const waves = within(moreSections).getByRole('tab', { name: 'Waves' });
      expect(waves).toHaveAttribute('href', '/automation/waves');
      expect(waves).toHaveAttribute('aria-selected', 'true');
      expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    },
  );

  it('selects Personas in More when a Persona desk is open', () => {
    mockPathname = '/personas/jim';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const personas = within(moreSections).getByRole('tab', { name: 'Personas' });
    expect(personas).toHaveAttribute('href', '/personas');
    expect(personas).toHaveAttribute('aria-selected', 'true');
  });

  it('selects Chain Chat in More when its experimental route is open', () => {
    mockPathname = '/chain-chat';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const chainChat = within(moreSections).getByRole('tab', { name: 'Chain Chat' });
    expect(chainChat).toHaveAttribute('href', '/chain-chat');
    expect(chainChat).toHaveAttribute('aria-selected', 'true');
  });

  it('puts experimental Personas and stable Roles in More when experiments are enabled', () => {
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
      'Waves',
      'Meetings',
      'Personas',
      'Roles',
      'Extensions',
      'Activity',
      'Chain Chat',
      'Help',
      'Settings',
    ]);
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
      '/automation/triggers',
      '/automation/waves',
      '/meetings',
      '/personas',
      '/roles',
      '/packages',
      '/statistics',
      '/chain-chat',
      '/docs',
      '/settings',
    ]);
    expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('shows enabled Waves, Personas, and stable Roles in the compact navigation drawer', () => {
    setCompactNavigation(true);
    mockPathname = '/automation/triggers';
    mockStorageValue = {
      settings: { experimental: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<Navigation />);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));
    const drawer = screen.getByRole('button', { name: 'Close navigation menu' }).closest('.MuiDrawer-paper');
    expect(drawer).not.toBeNull();
    expect(within(drawer as HTMLElement).getByRole('link', { name: 'Waves' })).toHaveAttribute(
      'href',
      '/automation/waves',
    );
    expect(within(drawer as HTMLElement).getByRole('link', { name: 'Personas' })).toHaveAttribute(
      'href',
      '/personas',
    );
    expect(within(drawer as HTMLElement).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'href',
      '/roles',
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

  it('keeps the Codex model catalog cache off by default and persists its opt-in', () => {
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
      name: /Use Codex's cached model catalog/i,
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(mockUpdateSettings).toHaveBeenCalledWith({
      speech: { enabled: true },
      experimental: {
        enabled: true,
        mcpBetaProtocol: true,
        codexModelCatalogCache: true,
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
    expect(screen.queryByText('MCP App consent')).not.toBeInTheDocument();
  });

  it('shows and updates remembered MCP App consent when click gating is enabled', async () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: false, requireMcpAppLaunchClick: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url === '/api/snapshots') {
        return { ok: false } as Response;
      }
      if (url === '/api/mcp/app-consent?manage=true') {
        return {
          ok: true,
          json: async () => ({
            entries: [{
              serverName: 'acme',
              uri: 'ui://acme/dashboard',
              decision: 'deny-always',
              updatedAt: 1,
            }],
          }),
        } as Response;
      }
      if (url === '/api/mcp/app-consent' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ status: 'granted' }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchSpy as typeof fetch;

    try {
      render(<ExperimentalFeaturesSettings />);

      expect(await screen.findByText('MCP App consent')).toBeInTheDocument();
      expect(await screen.findByText('ui://acme/dashboard')).toBeInTheDocument();
      expect(screen.getByText('Blocked')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
      await waitFor(() => expect(fetchSpy).toHaveBeenLastCalledWith(
        '/api/mcp/app-consent',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            serverName: 'acme',
            uri: 'ui://acme/dashboard',
            decision: 'allow-always',
          }),
        }),
      ));
      expect(await screen.findByText('Allowed')).toBeInTheDocument();
    } finally {
      if (originalFetch) global.fetch = originalFetch;
      else delete (global as { fetch?: typeof fetch }).fetch;
    }
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

  it('defaults filesystem snapshots and restore to off', () => {
    mockStorageValue = {
      settings: { speech: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);
    expect(
      screen.getByRole('checkbox', { name: /Enable filesystem snapshots and chat restore/i })
    ).not.toBeChecked();
  });

  it('persists disabling snapshots without dropping other settings', () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { enabled: true, mcpBetaProtocol: true, snapshotsEnabled: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Enable filesystem snapshots and chat restore/i })
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
});
