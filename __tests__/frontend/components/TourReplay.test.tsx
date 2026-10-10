import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import HomePage from '@/app/page';
import OnboardingSettings from '@/frontend/components/Settings/OnboardingSettings';
import TourOverlay from '@/frontend/components/Tour/TourOverlay';
import { TourProvider, useTour } from '@/frontend/contexts/TourContext';
import { createDefaultSettings } from '@/shared/config/defaultSettings';
import type { Settings } from '@/shared/types/storage';

const mockUseStorage = jest.fn();
const mockPersist = jest.fn();
let mockPathname = '/settings';
let mockNavigate: (path: string) => void;
let mockLatestSettings: Settings;
const mockRouter = { push: jest.fn((path: string) => mockNavigate(path)) };

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
}));
jest.mock('@/frontend/contexts/StorageContext', () => ({ useStorage: () => mockUseStorage() }));
jest.mock('@/frontend/services/model', () => ({ modelService: {
  tryLoadModels: async () => [{ id: 'model-1' }],
  loadModels: jest.fn(),
} }));
jest.mock('@/frontend/services/flow', () => ({ flowService: {
  loadFlows: async () => [{ id: 'agent-1' }],
} }));
jest.mock('@/frontend/services/chat', () => ({ chatService: { countConversations: async () => 1 } }));
jest.mock('@/frontend/components/FeedbackBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));

const labels = {
  ai: 'Dismiss Connect your AI card',
  assistant: 'Dismiss Create an agent card',
  talk: 'Dismiss Talk to your agent card',
  connectedApps: 'Dismiss connected apps notice',
};

function TourStatus() {
  const { isActive, endTour, startTour } = useTour();
  return <>
    <output aria-label="guide active">{String(isActive)}</output>
    <button onClick={endTour}>End guide</button>
    <button onClick={startTour}>Force guide start</button>
  </>;
}

/** Models StorageContext's real contract: publish settings only after the save. */
function Workspace({ initialSettings, initialPath = '/settings', hydrationSettings }: {
  initialSettings: Settings; initialPath?: string; hydrationSettings?: Settings;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [path, setPath] = useState(initialPath);
  const [settingsHydrated, setSettingsHydrated] = useState(!hydrationSettings);
  const [isLoading, setIsLoading] = useState(!!hydrationSettings);
  const updateSettings = useCallback(async (nextSettings: Settings) => {
    await mockPersist(nextSettings);
    setSettings(nextSettings);
  }, []);
  mockLatestSettings = settings;
  mockPathname = path;
  mockNavigate = (nextPath) => {
    window.history.replaceState({}, '', nextPath);
    setPath(nextPath);
  };
  mockUseStorage.mockReturnValue({ settings, updateSettings, isLoading, settingsHydrated });
  return <TourProvider>
    {hydrationSettings && <>
      <button onClick={() => setIsLoading(false)}>Finish loading without settings</button>
      <button onClick={() => {
        setSettings(hydrationSettings);
        setSettingsHydrated(true);
        setIsLoading(false);
      }}>Load saved settings</button>
    </>}
    {path === '/settings' ? <OnboardingSettings /> : <HomePage />}
    <TourStatus />
    <TourOverlay />
  </TourProvider>;
}

function initialSettings(): Settings {
  const settings = createDefaultSettings();
  settings.update = { ...settings.update, checkOnStartup: false };
  settings.onboarding = {
    completed: true,
    dashboardDismissedCards: ['ai', 'assistant', 'talk', 'connectedApps'],
    tutorials: { bigTutorialStage1: { status: 'paused', stepId: 'plain-chat', conversationId: 'saved-chat' } },
  };
  return settings;
}

function expectSetupTargets() {
  for (const card of ['ai', 'assistant', 'talk'] as const) {
    expect(screen.getByRole('button', { name: labels[card] })).toBeInTheDocument();
  }
  expect(document.querySelector('[data-tour="manage-ai-setup"]')).toBeInTheDocument();
  expect(document.querySelector('[data-tour="dashboard-create-flow"]')).toBeInTheDocument();
}

describe('guided tour replay from Settings and Home', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPersist.mockResolvedValue(undefined);
    window.history.replaceState({}, '', '/settings');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true, writable: true,
      value: jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const action = typeof init?.body === 'string' ? JSON.parse(init.body).action : '';
        return { ok: true, json: async () => action === 'check_initialized'
          ? { initialized: true } : { userEncryption: true } };
      }),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  it.each([
    { path: '/settings', replayButton: 'Replay guided tour' },
    { path: '/', replayButton: 'Open setup guide' },
  ])('waits for real settings before replay from $path, including after an unsuccessful load', async ({ path, replayButton }) => {
    const saved = initialSettings();
    render(<Workspace initialSettings={createDefaultSettings()} initialPath={path} hydrationSettings={saved} />);
    const replay = screen.getByRole('button', { name: replayButton });
    expect(replay).toBeDisabled();
    fireEvent.click(replay);
    fireEvent.click(screen.getByRole('button', { name: 'Force guide start' }));
    await act(async () => {});
    expect(screen.getByLabelText('guide active')).toHaveTextContent('false');
    expect(mockPersist).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finish loading without settings' }));
    expect(replay).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Force guide start' }));
    await act(async () => {});
    expect(screen.getByLabelText('guide active')).toHaveTextContent('false');
    expect(mockPersist).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Load saved settings' }));
    await waitFor(() => expect(replay).toBeEnabled());
    expect(mockLatestSettings).toEqual(saved);
    fireEvent.click(replay);
    await waitFor(expectSetupTargets);
    await waitFor(() => expect(mockLatestSettings).toEqual({
      ...saved,
      onboarding: { ...saved.onboarding, dashboardCardsHidden: false, dashboardDismissedCards: ['connectedApps'] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
    await waitFor(() => expect(screen.getByLabelText('guide active')).toHaveTextContent('false'));
    expectSetupTargets();
    expect(screen.queryByRole('button', { name: labels.connectedApps })).not.toBeInTheDocument();
  });

  it('restores Settings replay targets before its slow save finishes and preserves other settings', async () => {
    let finishSave!: () => void;
    mockPersist.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const original = initialSettings();
    render(<Workspace initialSettings={original} />);

    fireEvent.click(screen.getByRole('button', { name: 'Replay guided tour' }));
    await waitFor(expectSetupTargets);
    expect(mockRouter.push).toHaveBeenCalledWith('/');
    expect(screen.queryByRole('button', { name: labels.connectedApps })).not.toBeInTheDocument();
    expect(mockLatestSettings).toEqual(original);

    await act(async () => finishSave());
    await waitFor(() => expect(mockLatestSettings.onboarding?.dashboardDismissedCards).toEqual(['connectedApps']));
    expect(mockLatestSettings).toEqual({
      ...original,
      onboarding: { ...original.onboarding, dashboardCardsHidden: false, dashboardDismissedCards: ['connectedApps'] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
    await waitFor(() => expect(screen.getByLabelText('guide active')).toHaveTextContent('false'));
    expectSetupTargets();
  });

  it('restores legacy collectively hidden cards from Settings without hiding connected apps', async () => {
    const settings = initialSettings();
    settings.onboarding = { completed: true, dashboardCardsHidden: true };
    render(<Workspace initialSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay guided tour' }));

    await waitFor(expectSetupTargets);
    expect(screen.getByRole('button', { name: labels.connectedApps })).toBeInTheDocument();
    await waitFor(() => expect(mockLatestSettings.onboarding).toEqual({
      completed: true, dashboardCardsHidden: false, dashboardDismissedCards: [],
    }));
  });

  it('restores same-page session dismissals from Home while keeping connected apps dismissed', async () => {
    const settings = initialSettings();
    settings.onboarding!.dashboardDismissedCards = [];
    render(<Workspace initialSettings={settings} initialPath="/" />);
    await waitFor(expectSetupTargets);
    for (const card of ['ai', 'assistant', 'talk', 'connectedApps'] as const) {
      fireEvent.click(screen.getByRole('button', { name: labels[card] }));
      await waitFor(() => expect(mockLatestSettings.onboarding?.dashboardDismissedCards).toContain(card));
    }
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open setup guide' }));
    await waitFor(expectSetupTargets);
    await waitFor(() => expect(mockLatestSettings.onboarding?.dashboardDismissedCards).toEqual(['connectedApps']));
    expect(screen.queryByRole('button', { name: labels.connectedApps })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
    await waitFor(() => expect(screen.getByLabelText('guide active')).toHaveTextContent('false'));
    expectSetupTargets();

    fireEvent.click(screen.getByRole('button', { name: labels.ai }));
    await waitFor(() => expect(mockLatestSettings.onboarding?.dashboardDismissedCards).toEqual(['ai', 'connectedApps']));
    expect(screen.queryByRole('button', { name: labels.ai })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.assistant })).toBeInTheDocument();
  });

  it('preserves restored cards when Skip is clicked before the restoration save completes', async () => {
    let finishSave!: () => void;
    mockPersist.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const original = initialSettings();
    render(<Workspace initialSettings={original} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay guided tour' }));
    await waitFor(expectSetupTargets);
    fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
    expect(mockPersist).toHaveBeenCalledTimes(1);

    await act(async () => finishSave());
    await waitFor(() => expect(mockPersist).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockLatestSettings.onboarding).toEqual({
      ...original.onboarding, completed: true, dashboardCardsHidden: false, dashboardDismissedCards: ['connectedApps'],
    }));
    expectSetupTargets();
  });

  it('orders replay after an earlier Home dismissal that is still saving', async () => {
    let finishDismissal!: () => void;
    mockPersist.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDismissal = resolve; }));
    const settings = initialSettings();
    settings.onboarding!.dashboardDismissedCards = ['connectedApps'];
    render(<Workspace initialSettings={settings} initialPath="/" />);
    await waitFor(expectSetupTargets);
    fireEvent.click(screen.getByRole('button', { name: labels.ai }));
    await waitFor(() => expect(mockPersist).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: labels.ai })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open setup guide' }));
    expectSetupTargets();
    expect(mockPersist).toHaveBeenCalledTimes(1);
    await act(async () => finishDismissal());
    await waitFor(() => expect(mockLatestSettings.onboarding?.dashboardDismissedCards).toEqual(['connectedApps']));
    fireEvent.click(screen.getByRole('button', { name: 'End guide' }));
    await waitFor(() => expect(screen.getByLabelText('guide active')).toHaveTextContent('false'));
    expectSetupTargets();
    expect(screen.queryByRole('button', { name: labels.connectedApps })).not.toBeInTheDocument();
  });
});
