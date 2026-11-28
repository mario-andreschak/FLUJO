/**
 * Navigation and the Settings > Advanced page (issues #184, #1449).
 *
 *  - The setup-first primary navigation remains small and ordered, while
 *    secondary destinations stay inside More. Nothing hides behind a switch.
 *  - The Advanced page keeps only real choices and saves them merged.
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
      matches: query === '(max-width:1535px)' ? compact : false,
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

describe('setup-first navigation (#184, #325, #1449)', () => {
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

  it('shows every More destination without any switch, even before settings load', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = { settings: {}, settingsHydrated: false, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const tabs = within(moreSections).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Automations', 'Meetings', 'Experimental', 'Help', 'Settings']);
    expect(within(moreSections).getByRole('tab', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it.each(['/automation/waves', '/waves'])(
    'selects Waves in More when %s is open',
    (pathname) => {
      mockPathname = pathname;
      mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
      render(<Navigation />);

      const moreSections = screen.getByRole('tablist', { name: 'More sections' });
      const experimental = within(moreSections).getByRole('tab', { name: 'Experimental · Waves' });
      expect(experimental).toHaveAttribute('aria-selected', 'true');
      expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    },
  );

  it('selects Personas in More when a Persona desk is open', () => {
    mockPathname = '/personas/jim';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    expect(within(moreSections).getByRole('tab', { name: 'Experimental · Personas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('selects Chain Chat in More when its experimental route is open', () => {
    mockPathname = '/chain-chat';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    expect(within(moreSections).getByRole('tab', { name: 'Experimental · Chain Chat' })).toHaveAttribute('aria-selected', 'true');
    // A group wider than the window scrolls instead of hiding its first sections (#1320).
    expect(moreSections.closest('.MuiTabs-root')?.querySelector('.MuiTabs-scrollableX')).not.toBeNull();
  });

  it('lists Harness Lab, Personas and the other newer pages in one More menu', () => {
    mockPathname = '/automation/triggers';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);

    const moreSections = screen.getByRole('tablist', { name: 'More sections' });
    const tabs = within(moreSections).getAllByRole('tab');
    // Newer sections share one menu (#1278).
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Automations', 'Meetings', 'Experimental', 'Help', 'Settings']);
    expect(within(moreSections).getByRole('tab', { name: 'Automations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(within(moreSections).getByRole('tab', { name: 'Experimental' }));
    const menu = screen.getByRole('menu', { name: 'Experimental' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Harness Lab', 'Personas', 'Roles', 'Extensions', 'Activity', 'Chain Chat', 'Waves']);
    expect(items.map((item) => item.getAttribute('href'))).toEqual([
      '/harness', '/personas', '/roles', '/packages', '/statistics', '/chain-chat', '/automation/waves',
    ]);
  });

  it('offers API reference, tutorials and per-page help from the Help menu', () => {
    mockPathname = '/settings';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<Navigation />);
    fireEvent.click(within(screen.getByRole('tablist', { name: 'More sections' })).getByRole('tab', { name: 'Help' }));
    const menu = screen.getByRole('menu', { name: 'Help' });
    expect(within(menu).getByRole('menuitem', { name: 'API reference' })).toHaveAttribute('href', '/docs');
    expect(within(menu).getByRole('menuitem', { name: 'Tutorials' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Connected Apps' })).toHaveAttribute(
      'href', 'https://github.com/mario-andreschak/FLUJO/blob/main/docs/features/mcp',
    );
  });

  it('shows Waves, Personas, and Roles in the compact navigation drawer', () => {
    setCompactNavigation(true);
    mockPathname = '/automation/triggers';
    mockStorageValue = { settings: {}, settingsHydrated: true, updateSettings: mockUpdateSettings };
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

describe('Settings > Advanced (#184, #1449)', () => {
  beforeEach(() => {
    mockUpdateSettings.mockClear();
  });

  it('keeps only real choices, in task-oriented order', () => {
    mockStorageValue = { settings: { speech: { enabled: true } }, settingsHydrated: true, updateSettings: mockUpdateSettings };
    render(<ExperimentalFeaturesSettings />);

    const headings = ['Context management', 'MCP and apps', 'Snapshots and recovery']
      .map((name) => screen.getByRole('heading', { name }));
    headings.slice(1).forEach((heading, index) => {
      expect(headings[index].compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    });
    expect(screen.getAllByRole('switch').map((toggle) => toggle.getAttribute('name')).filter(Boolean).sort())
      .toEqual(['requireMcpAppLaunchClick', 'restrictMcpFilesystemToRoots']);
    expect(screen.queryByRole('switch', { name: /Experimental Features/i })).not.toBeInTheDocument();
  });

  it('defaults MCP App click gating and MCP roots confinement to off', () => {
    mockStorageValue = {
      settings: { speech: { enabled: true } },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    expect(screen.getByRole('switch', {
      name: /Require a click to open allowed MCP Apps/i,
    })).not.toBeChecked();
    expect(screen.getByRole('switch', {
      name: /Restrict MCP filesystem access to configured roots/i,
    })).not.toBeChecked();
    expect(screen.queryByText('MCP App consent')).not.toBeInTheDocument();
  });

  it('shows and updates remembered MCP App consent when click gating is enabled', async () => {
    mockStorageValue = {
      settings: {
        speech: { enabled: true },
        experimental: { requireMcpAppLaunchClick: true },
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
        experimental: { claudeSessionResume: true },
      },
      settingsHydrated: true,
      updateSettings: mockUpdateSettings,
    };
    render(<ExperimentalFeaturesSettings />);

    fireEvent.click(screen.getByRole('switch', {
      name: /Require a click to open allowed MCP Apps/i,
    }));
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      speech: { enabled: true },
      experimental: {
        claudeSessionResume: true,
        requireMcpAppLaunchClick: true,
      },
    });

    fireEvent.click(screen.getByRole('switch', {
      name: /Restrict MCP filesystem access to configured roots/i,
    }));
    expect(mockUpdateSettings).toHaveBeenLastCalledWith({
      speech: { enabled: true },
      experimental: {
        claudeSessionResume: true,
        restrictMcpFilesystemToRoots: true,
      },
    });
  });
});
