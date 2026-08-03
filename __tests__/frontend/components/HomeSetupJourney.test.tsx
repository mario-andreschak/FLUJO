import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockTryLoadModels = jest.fn();
const mockLoadFlows = jest.fn();
const mockCountConversations = jest.fn();
const mockStartTour = jest.fn();
const mockUpdateSettings = jest.fn();
let mockSettings: {
  update: { checkOnStartup: boolean };
  onboarding?: { completed: boolean; dashboardCardsHidden?: boolean };
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
    expect(screen.queryByRole('button', { name: 'Hide completed setup steps' })).not.toBeInTheDocument();
  });

  it('marks Talk complete and offers to hide the setup cards when chats exist', async () => {
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);
    mockCountConversations.mockResolvedValue(1);

    render(<HomePage />);

    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    const hideButton = screen.getByRole('button', { name: 'Hide completed setup steps' });
    fireEvent.click(hideButton);

    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
      onboarding: expect.objectContaining({
        completed: true,
        dashboardCardsHidden: true,
      }),
    }));
  });

  it('keeps hidden setup cards reversible after completion', async () => {
    mockSettings = {
      update: { checkOnStartup: false },
      onboarding: { completed: true, dashboardCardsHidden: true },
    };
    mockTryLoadModels.mockResolvedValue([{ id: 'model-1' }]);
    mockLoadFlows.mockResolvedValue([{ id: 'assistant-1' }]);
    mockCountConversations.mockResolvedValue(1);

    render(<HomePage />);

    const showButton = await screen.findByRole('button', { name: 'Show setup steps' });
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();

    fireEvent.click(showButton);
    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({
      onboarding: expect.objectContaining({ dashboardCardsHidden: false }),
    }));
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
