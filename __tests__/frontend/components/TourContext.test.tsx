import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TourProvider, useTour } from '@/frontend/contexts/TourContext';

const mockUseStorage = jest.fn();

jest.mock('@/frontend/contexts/StorageContext', () => ({
  useStorage: () => mockUseStorage(),
}));

function Harness() {
  const { bigTutorialProgress, nextBigTutorial, restartBigTutorial } = useTour();
  return (
    <>
      <output aria-label="tutorial step">{bigTutorialProgress.stepId}</output>
      <output aria-label="tutorial conversation">{bigTutorialProgress.conversationId ?? 'none'}</output>
      <button onClick={() => void nextBigTutorial()}>Next tutorial step</button>
      <button onClick={() => void restartBigTutorial()}>Restart tutorial</button>
    </>
  );
}

describe('TourProvider tutorial progress', () => {
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
