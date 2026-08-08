import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockTryLoadModels = jest.fn();
const mockLoadFlows = jest.fn();
const mockCountConversations = jest.fn();
const mockStartTour = jest.fn();
const mockUpdateSettings = jest.fn();
let mockSettings: {
  update: { checkOnStartup: boolean };
  onboarding?: { completed: boolean; dashboardCardsHidden?: boolean; dashboardDismissedCards?: string[] };
};

jest.mock('@/frontend/services/model', () => ({
  modelService: { tryLoadModels: (...args: unknown[]) => mockTryLoadModels(...args) },
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => mockLoadFlows(...args) },
}));

jest.mock('@/frontend/services/chat', () => ({
  chatService: { countConversations: (...args: unknown[]) => mockCountConversations(...args) },
}));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => ({ settings: mockSettings, updateSettings: mockUpdateSettings }),
}));

jest.mock('@/frontend/contexts/TourContext', () => ({
  useTour: () => ({ startTour: mockStartTour }),
}));

jest.mock('@/frontend/components/FeedbackBanner', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import HomePage from '@/app/page';

const okJson = (body: object) => ({
  ok: true,
  json: async () => body,
});

const dismissLabels = {
  ai: 'Dismiss Connect your AI card',
  assistant: 'Dismiss Create an agent card',
  talk: 'Dismiss Talk to your agent card',
  connectedApps: 'Dismiss connected apps notice',
};

const lastDismissedCards = () => {
  const call = mockUpdateSettings.mock.calls.at(-1)?.[0];
  return call?.onboarding?.dashboardDismissedCards as string[] | undefined;
};

describe('setup-first home journey', () => {
  beforeEach(() => {
    mockTryLoadModels.mockReset();
    mockLoadFlows.mockReset();
    mockCountConversations.mockReset();
    mockCountConversations.mockResolvedValue(0);
    mockStartTour.mockReset();
    mockUpdateSettings.mockReset();
    mockUpdateSettings.mockResolvedValue(undefined);
    mockSettings = {
      update: { checkOnStartup: false },
      onboarding: { completed: true },
    };
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        if (payload.action === 'check_initialized') return okJson({ initialized: true }) as Response;
        if (payload.action === 'check_user_encryption') return okJson({ userEncryption: true }) as Response;
        return okJson({}) as Response;
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  const renderCompletedDashboard = async () => {
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);
    mockCountConversations.mockResolvedValue(1);

    const result = render(<HomePage />);
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    return result;
  };

  it('requires AI setup before agent creation or chat', async () => {
    mockTryLoadModels.mockResolvedValue([]);
    mockLoadFlows.mockResolvedValue([]);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Required')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Connect AI' })).toHaveAttribute('href', '/models?add=1');
    expect(screen.getByRole('button', { name: 'Connect AI first' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Finish AI setup first' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: /What would you like AI to help with/i })).not.toBeInTheDocument();
  });

  it('unlocks the simple builder after a model is connected but keeps Talk gated', async () => {
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([]);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Manage AI setup' })).toHaveAttribute('href', '/models');
    expect(screen.getByRole('link', { name: 'Open simple builder' })).toHaveAttribute(
      'href',
      '/flows?create=assistant',
    );
    expect(screen.getByRole('button', { name: 'Create an agent first' })).toBeDisabled();
  });

  it('unlocks Talk after both a model and an agent exist', async () => {
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('1 ready')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Create another' })).toHaveAttribute(
      'href',
      '/flows?create=assistant',
    );
    expect(screen.getByRole('link', { name: 'Start talking' })).toHaveAttribute('href', '/chat');
  });

  it('no longer offers the collective hide/show toggle', async () => {
    await renderCompletedDashboard();

    expect(screen.queryByRole('button', { name: 'Hide completed setup steps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show setup steps' })).not.toBeInTheDocument();
  });

  it('exposes an accessible dismiss control on every dashboard card', async () => {
    await renderCompletedDashboard();

    for (const label of Object.values(dismissLabels)) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('dismisses only the selected setup card and preserves unrelated settings', async () => {
    await renderCompletedDashboard();

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.assistant }));

    expect(screen.queryByRole('button', { name: dismissLabels.assistant })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: dismissLabels.ai })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: dismissLabels.talk })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: dismissLabels.connectedApps })).toBeInTheDocument();
    expect(screen.queryByText('Create an agent')).not.toBeInTheDocument();

    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
      update: { checkOnStartup: false },
      onboarding: expect.objectContaining({
        completed: true,
        dashboardDismissedCards: ['assistant'],
      }),
    }));
  });

  it('dismisses the connected apps card without touching the setup cards', async () => {
    await renderCompletedDashboard();

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.connectedApps }));

    expect(screen.queryByText('Connected Apps are optional')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: dismissLabels.ai })).toBeInTheDocument();
    expect(lastDismissedCards()).toEqual(['connectedApps']);
  });

  it('keeps earlier dismissals when several cards are dismissed in sequence', async () => {
    await renderCompletedDashboard();

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.ai }));
    expect(lastDismissedCards()).toEqual(['ai']);

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.talk }));
    expect(lastDismissedCards()).toEqual(['ai', 'talk']);

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.connectedApps }));
    expect(lastDismissedCards()).toEqual(['ai', 'talk', 'connectedApps']);
  });

  it('keeps persisted dismissals hidden after a reload', async () => {
    mockSettings = {
      update: { checkOnStartup: false },
      onboarding: { completed: true, dashboardDismissedCards: ['talk', 'connectedApps'] },
    };

    await renderCompletedDashboard();

    expect(screen.getByRole('button', { name: dismissLabels.ai })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: dismissLabels.talk })).not.toBeInTheDocument();
    expect(screen.queryByText('Connected Apps are optional')).not.toBeInTheDocument();
  });

  it('renders no empty setup grid once every setup card is dismissed', async () => {
    mockSettings = {
      update: { checkOnStartup: false },
      onboarding: { completed: true, dashboardDismissedCards: ['ai', 'assistant', 'talk'] },
    };
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);
    mockCountConversations.mockResolvedValue(1);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Connected Apps are optional')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
  });

  it('honors the legacy collective hidden flag without hiding connected apps', async () => {
    mockSettings = {
      update: { checkOnStartup: false },
      onboarding: { completed: true, dashboardCardsHidden: true },
    };
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);
    mockCountConversations.mockResolvedValue(1);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Connected Apps are optional')).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: dismissLabels.connectedApps }));

    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
      onboarding: expect.objectContaining({
        completed: true,
        dashboardCardsHidden: false,
        dashboardDismissedCards: ['ai', 'assistant', 'talk', 'connectedApps'],
      }),
    }));
  });

  it('allows dismissing an incomplete setup card without triggering its action', async () => {
    mockTryLoadModels.mockResolvedValue([]);
    mockLoadFlows.mockResolvedValue([]);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Required')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: dismissLabels.ai }));

    expect(screen.queryByRole('link', { name: 'Connect AI' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: dismissLabels.assistant })).toBeInTheDocument();
    expect(lastDismissedCards()).toEqual(['ai']);
  });

  it('does not mislabel a failed model check as missing setup', async () => {
    mockTryLoadModels.mockResolvedValue(null);
    mockLoadFlows.mockResolvedValue([]);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Open to check')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Open AI setup' })).toHaveAttribute('href', '/models');
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
  });
});
