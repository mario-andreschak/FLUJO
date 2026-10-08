import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Model } from '@/shared/types';

const mockHistory: string[] = [];
const mockLocationListeners = new Set<() => void>();
const mockLocation = () => mockHistory[mockHistory.length - 1];
const mockNotifyNavigation = () => {
  window.history.replaceState({}, '', mockLocation());
  mockLocationListeners.forEach(listener => listener());
};
const mockRouter = {
  push: jest.fn((url: string) => { mockHistory.push(url); mockNotifyNavigation(); }),
  replace: jest.fn((url: string) => { mockHistory[mockHistory.length - 1] = url; mockNotifyNavigation(); }),
  back: jest.fn(() => { mockHistory.pop(); mockNotifyNavigation(); }),
  refresh: jest.fn(),
};
let mockModels: Model[] = [];
const mockLoadModels = jest.fn(async () => mockModels);
const mockAddModel = jest.fn(async (model: Model) => {
  mockModels = [...mockModels, model];
  return { success: true, model };
});
const mockT = (key: string) => key;

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => {
    const { useSyncExternalStore } = jest.requireActual('react');
    useSyncExternalStore((listener: () => void) => {
      mockLocationListeners.add(listener);
      return () => { mockLocationListeners.delete(listener); };
    }, mockLocation, mockLocation);
    return new URLSearchParams(window.location.search);
  },
}));
jest.mock('@/frontend/services/model', () => ({
  getModelService: () => ({ loadModels: mockLoadModels, addModel: mockAddModel }),
}));
jest.mock('@/frontend/services/flow', () => ({ flowService: {} }));
jest.mock('@/frontend/components/models/list/ModelList', () => ({
  __esModule: true,
  default: ({ models }: { models: Model[] }) => <div>{models.map(model => <div key={model.id}>{model.displayName}</div>)}</div>,
}));
jest.mock('@/frontend/components/models/modal', () => ({
  __esModule: true,
  default: ({ model, onSave, onClose }: {
    model: Model; onSave: (model: Model) => Promise<unknown>; onClose: () => Promise<void>;
  }) => (
    <div role="dialog" aria-label="Manual model setup">
      <button onClick={() => void onSave({ ...model, name: 'fixture-model', displayName: 'Saved fixture model' })}>Save model</button>
      <button onClick={() => void onClose()}>Cancel model</button>
    </div>
  ),
}));
jest.mock('@/frontend/components/models/ModelConnectionWizard', () => ({
  __esModule: true,
  default: ({ open, onManualCreation }: { open: boolean; onManualCreation: () => void }) => open ? (
    <div role="dialog" aria-label="Guided model setup"><button onClick={onManualCreation}>I’m an expert</button></div>
  ) : null,
}));
jest.mock('@/frontend/components/Chat/QuickChatDialog', () => ({ __esModule: true, default: () => null }));
jest.mock('@/frontend/components/shared/StickySearchBar', () => ({
  __esModule: true, default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/frontend/hooks/useAutoFocusSearch', () => ({ useAutoFocusSearch: () => ({ current: null }) }));
jest.mock('@/frontend/contexts/I18nContext', () => ({ useI18n: () => ({ t: mockT }) }));
jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ useAskFlujoPage: jest.fn() }));

import ModelClient from '@/app/models/ModelClient';

describe('model setup history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModels = [];
    mockHistory.splice(0, mockHistory.length, '/', '/models?add=1');
    window.history.replaceState({}, '', mockLocation());
  });
  afterEach(() => { window.history.replaceState({}, '', '/'); });

  it.each(['Save model', 'Cancel model'])('closes a Home/deep-link wizard after manual %s without reopening it', async action => {
    render(<ModelClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'I’m an expert' }));
    fireEvent.click(await screen.findByRole('button', { name: action }));
    await waitFor(() => expect(mockLocation()).toBe('/models'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockHistory).toEqual(['/', '/models']);
    expect(mockRouter.back).not.toHaveBeenCalled();
    if (action === 'Save model') expect(screen.getByText('Saved fixture model')).toBeInTheDocument();
    else expect(mockAddModel).not.toHaveBeenCalled();
  });

  it('returns to the dashboard after saving through guided-to-manual setup opened on that dashboard', async () => {
    mockHistory[mockHistory.length - 1] = '/models';
    window.history.replaceState({}, '', mockLocation());
    render(<ModelClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'models.connectAi' }));
    fireEvent.click(await screen.findByRole('button', { name: 'I’m an expert' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(screen.getByText('Saved fixture model')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockLocation()).toBe('/models');
    expect(mockHistory).toEqual(['/', '/models']);
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
