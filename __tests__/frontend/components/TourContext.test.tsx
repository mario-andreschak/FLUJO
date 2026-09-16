import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TourProvider, useTour } from '@/frontend/contexts/TourContext';
import { buildTutorialChatFlow } from '@/frontend/components/Tour/bigTutorialFlow';
import { emitBigTutorialEvent } from '@/frontend/components/Tour/bigTutorialEvents';
import { TOUR_STEPS } from '@/frontend/components/Tour/tourSteps';

const mockUseStorage = jest.fn();
const mockLoadModels = jest.fn();
const mockLoadFlows = jest.fn();
const mockAddFlow = jest.fn();
const mockUpdateFlow = jest.fn();

jest.mock('@/frontend/services/model', () => ({ modelService: { loadModels: () => mockLoadModels() } }));
jest.mock('@/frontend/services/flow', () => ({ flowService: {
  loadFlows: () => mockLoadFlows(),
  addFlow: (...args: unknown[]) => mockAddFlow(...args),
  updateFlow: (...args: unknown[]) => mockUpdateFlow(...args),
} }));

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockUseStorage(),
}));

function Harness() {
  const { bigTutorialProgress, bigTutorialError, bigTutorialRunStatus, isBigTutorialActive, next, endTour, startBigTutorial, nextBigTutorial, restartBigTutorial, runBigTutorialAction } = useTour();
  return (
    <>
      <output aria-label="tutorial step">{bigTutorialProgress.stepId}</output>
      <output aria-label="tutorial conversation">{bigTutorialProgress.conversationId ?? 'none'}</output>
      <output aria-label="tutorial error">{bigTutorialError}</output>
      <output aria-label="tutorial run">{bigTutorialRunStatus ?? 'none'}</output>
      <output aria-label="tutorial active">{String(isBigTutorialActive)}</output>
      <button onClick={next}>Next intro step</button>
      <button onClick={endTour}>Skip intro</button>
      <button onClick={() => void startBigTutorial()}>Start long tutorial</button>
      <button onClick={() => void runBigTutorialAction()}>Run tutorial action</button>
      <button onClick={() => void nextBigTutorial()}>Next tutorial step</button>
      <button onClick={() => void restartBigTutorial()}>Restart tutorial</button>
    </>
  );
}

describe('TourProvider tutorial progress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadModels.mockResolvedValue([{ id: 'model-1', name: 'model', provider: 'openai' }]);
    mockLoadFlows.mockResolvedValue([]);
    mockAddFlow.mockResolvedValue({ success: true });
    mockUpdateFlow.mockResolvedValue({ success: true });
    mockUseStorage.mockReturnValue({
      settings: { onboarding: { completed: true, tutorials: { bigTutorialStage1: { status: 'active', stepId: 'intro' } } } },
      updateSettings: jest.fn(async () => {}),
      isLoading: false,
      settingsHydrated: true,
    });
  });

  it.each(['skip', 'complete'])('does not start the long tutorial when users %s the introductory tour', async action => {
    const updateSettings = jest.fn(async () => {});
    const storage = {
      settings: { onboarding: { completed: false } }, updateSettings, isLoading: false, settingsHydrated: true,
    };
    mockUseStorage.mockReturnValue(storage);
    const view = render(<TourProvider><Harness /></TourProvider>);
    if (action === 'skip') fireEvent.click(screen.getByRole('button', { name: 'Skip intro' }));
    else for (const _step of TOUR_STEPS) fireEvent.click(screen.getByRole('button', { name: 'Next intro step' }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ onboarding: { completed: true } })));
    mockUseStorage.mockReturnValue({ ...storage, settings: { onboarding: { completed: true } } });
    view.rerender(<TourProvider><Harness /></TourProvider>);
    expect(screen.getByLabelText('tutorial active')).toHaveTextContent('false');
    expect(mockLoadModels).not.toHaveBeenCalled();
    expect(mockAddFlow).not.toHaveBeenCalled();
  });

  it('starts the long tutorial only on request and restores an explicitly active tutorial', async () => {
    mockUseStorage.mockReturnValue({ settings: { onboarding: { completed: true } }, updateSettings: jest.fn(async () => {}), isLoading: false, settingsHydrated: true });
    const view = render(<TourProvider><Harness /></TourProvider>);
    expect(screen.getByLabelText('tutorial active')).toHaveTextContent('false');
    fireEvent.click(screen.getByRole('button', { name: 'Start long tutorial' }));
    await waitFor(() => expect(screen.getByLabelText('tutorial active')).toHaveTextContent('true'));
    view.unmount();
    mockUseStorage.mockReturnValue({ settings: { onboarding: { completed: true, tutorials: { bigTutorialStage1: { status: 'active', stepId: 'intro' } } } }, updateSettings: jest.fn(async () => {}), isLoading: false, settingsHydrated: true });
    render(<TourProvider><Harness /></TourProvider>);
    expect(screen.getByLabelText('tutorial active')).toHaveTextContent('true');
  });

  it('redirects an empty workspace to AI setup without creating an unusable agent, then continues once a model is saved', async () => {
    mockLoadModels.mockResolvedValue([]);
    render(<TourProvider><Harness /></TourProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Run tutorial action' }));
    await waitFor(() => expect(screen.getByLabelText('tutorial step')).toHaveTextContent('connect-ai'));
    expect(mockAddFlow).not.toHaveBeenCalled();

    mockLoadModels.mockResolvedValue([{ id: 'new-model', name: 'model', provider: 'openai' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Run tutorial action' }));
    await waitFor(() => expect(screen.getByLabelText('tutorial step')).toHaveTextContent('go-to-chat'));
    expect(mockAddFlow.mock.calls[0][0].nodes.find((node: { data: { type: string } }) => node.data.type === 'process').data.properties.boundModel).toBe('new-model');
  });

  it.each([undefined, 'deleted-model'])('repairs an existing tutorial agent with missing binding %s before advancing', async (boundModel) => {
    let id = 0;
    const { flow, processNodeId } = buildTutorialChatFlow('old-model', () => `node-${++id}`);
    const process = flow.nodes.find(node => node.id === processNodeId)!;
    process.data.properties!.boundModel = boundModel;
    process.data.properties!.promptTemplate = 'Keep my custom prompt';
    mockLoadFlows.mockResolvedValue([flow]);
    render(<TourProvider><Harness /></TourProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Run tutorial action' }));
    await waitFor(() => expect(screen.getByLabelText('tutorial step')).toHaveTextContent('go-to-chat'));
    const repaired = mockUpdateFlow.mock.calls[0][0];
    expect(repaired.id).toBe(flow.id);
    expect(repaired.nodes.find((node: { id: string }) => node.id === processNodeId).data.properties).toMatchObject({
      boundModel: 'model-1', promptTemplate: 'Keep my custom prompt',
    });
    expect(mockAddFlow).not.toHaveBeenCalled();
  });

  it('ignores run completion from a different conversation', () => {
    render(<TourProvider><Harness /></TourProvider>);
    act(() => emitBigTutorialEvent({ type: 'conversation-created', conversationId: 'tutorial-chat' }));
    act(() => emitBigTutorialEvent({ type: 'chat-run-status', conversationId: 'other-chat', status: 'completed' }));
    expect(screen.getByLabelText('tutorial run')).toHaveTextContent('none');
    act(() => emitBigTutorialEvent({ type: 'chat-run-status', conversationId: 'tutorial-chat', status: 'error' }));
    expect(screen.getByLabelText('tutorial run')).toHaveTextContent('error');
  });

  it('updates the visible step before durable settings persistence finishes', async () => {
    let finishPersistence!: () => void;
    const pendingPersistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    mockUseStorage.mockReturnValue({
      settings: {
        onboarding: {
          completed: true,
          tutorials: { bigTutorialStage1: { status: 'active', stepId: 'intro' } },
        },
      },
      updateSettings: jest.fn(() => pendingPersistence),
      isLoading: false,
      settingsHydrated: true,
    });

    render(<TourProvider><Harness /></TourProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Next tutorial step' }));

    expect(screen.getByLabelText('tutorial step')).toHaveTextContent('go-to-chat');

    await act(async () => finishPersistence());
  });

  it('restarts with fresh progress and no old conversation pointer', () => {
    mockUseStorage.mockReturnValue({
      settings: {
        onboarding: {
          completed: true,
          tutorials: {
            bigTutorialStage1: {
              status: 'paused',
              stepId: 'wait-for-first-answer',
              conversationId: 'old-conversation',
            },
          },
        },
      },
      updateSettings: jest.fn(async () => {}),
      isLoading: false,
      settingsHydrated: true,
    });

    render(<TourProvider><Harness /></TourProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Restart tutorial' }));

    expect(screen.getByLabelText('tutorial step')).toHaveTextContent('intro');
    expect(screen.getByLabelText('tutorial conversation')).toHaveTextContent('none');
  });
});
