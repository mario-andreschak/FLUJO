import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WORKSPACE_STORAGE_KEY } from '@/frontend/utils/workspaceSelection';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
};
const mockLoadModels = jest.fn();
const mockCreateModelAgent = jest.fn();
const mockNavigateWorkspaceRoute = jest.fn();
const mockT = (key: string) => key;

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

jest.mock('uuid', () => ({
  v4: () => 'creation-id',
}));

jest.mock('@/frontend/services/model', () => ({
  getModelService: () => ({
    loadModels: (...args: unknown[]) => mockLoadModels(...args),
  }),
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    createModelAgent: (...args: unknown[]) => mockCreateModelAgent(...args),
  },
}));

jest.mock('@/frontend/components/models/list/ModelList', () => ({
  __esModule: true,
  default: ({
    onConvertToAgent,
  }: {
    onConvertToAgent?: (modelId: string) => void;
  }) => (
    <button type="button" onClick={() => onConvertToAgent?.('model-1')}>
      Convert model
    </button>
  ),
}));

jest.mock('@/frontend/components/Chat/QuickChatDialog', () => ({
  __esModule: true,
  default: ({
    initialModelId,
    lockModelSelection,
    onStart,
  }: {
    initialModelId?: string;
    lockModelSelection?: boolean;
    onStart: (selection: {
      modelId: string;
      flowName: string;
      servers: Array<{ name: string; enabledTools?: string[] }>;
      systemPrompt?: string;
    }) => Promise<void>;
  }) => (
    <div data-testid="conversion-dialog">
      <span>{initialModelId}</span>
      <span>{String(lockModelSelection)}</span>
      <button
        type="button"
        onClick={() => {
          void onStart({
            modelId: initialModelId ?? '',
            flowName: 'Converted agent',
            servers: [{ name: 'connected-app', enabledTools: ['lookup'] }],
            systemPrompt: 'Be useful.',
          });
        }}
      >
        Save converted agent
      </button>
    </div>
  ),
}));

jest.mock('@/frontend/components/models/modal', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/components/models/ModelConnectionWizard', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/components/shared/StickySearchBar', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('@/frontend/components/shared/Spinner', () => ({
  __esModule: true,
  default: () => <div>Loading models</div>,
}));

jest.mock('@/frontend/hooks/useAutoFocusSearch', () => ({
  useAutoFocusSearch: () => ({ current: null }),
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: mockT }),
}));

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujoPage: jest.fn(),
}));

jest.mock('@/frontend/utils/workspaceNavigation', () => ({
  navigateWorkspaceRoute: (...args: unknown[]) => mockNavigateWorkspaceRoute(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import ModelClient from '@/app/models/ModelClient';

describe('model-to-agent conversion navigation', () => {
  beforeEach(() => {
    mockRouter.push.mockReset();
    mockRouter.replace.mockReset();
    mockRouter.back.mockReset();
    mockNavigateWorkspaceRoute.mockReset();
    mockCreateModelAgent.mockReset().mockResolvedValue({
      flowId: 'created-flow',
      name: 'Converted agent',
    });
    mockLoadModels.mockReset().mockResolvedValue([{
      id: 'model-1',
      name: 'source-model',
      displayName: 'Source Model',
      description: '',
      ApiKey: 'must-not-leave-model-state',
      baseUrl: '',
      provider: 'openai',
      promptTemplate: '',
      temperature: '0',
    }]);
    window.localStorage.clear();
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'game-dev');
    window.history.replaceState({}, '', '/models?workspace=game-dev');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('opens the converted flow through the workspace-aware advanced editor contract', async () => {
    render(<ModelClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'Convert model' }));
    expect(await screen.findByTestId('conversion-dialog')).toHaveTextContent('model-1true');

    fireEvent.click(screen.getByRole('button', { name: 'Save converted agent' }));

    await waitFor(() => expect(mockCreateModelAgent).toHaveBeenCalledWith({
      creationId: 'creation-id',
      modelId: 'model-1',
      name: 'Converted agent',
      servers: [{ name: 'connected-app', enabledTools: ['lookup'] }],
      systemPrompt: 'Be useful.',
    }));
    expect(mockNavigateWorkspaceRoute).toHaveBeenCalledWith(
      mockRouter,
      '/flows?flow=created-flow&mode=edit&authoringMode=advanced&workspace=game-dev',
    );
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
