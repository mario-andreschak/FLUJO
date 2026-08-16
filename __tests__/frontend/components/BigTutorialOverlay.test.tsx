import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BigTutorialOverlay from '@/frontend/components/Tour/BigTutorialOverlay';

const mockPush = jest.fn();
const mockNextBigTutorial = jest.fn(async () => {});
const mockRestartBigTutorial = jest.fn(async () => {});
const mockUseTour = jest.fn();

jest.mock('next/navigation', () => ({
  usePathname: () => '/chat',
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('@/frontend/contexts/TourContext', () => ({
  useTour: () => mockUseTour(),
}));

function tutorialState(overrides: Record<string, unknown> = {}) {
  return {
    isBigTutorialActive: true,
    bigTutorialProgress: {
      status: 'active',
      stepId: 'wait-for-first-answer',
      conversationId: 'conversation-1',
    },
    bigTutorialBusy: false,
    bigTutorialError: null,
    bigTutorialRunStatus: null,
    bigTutorialConnectedServer: null,
    nextBigTutorial: mockNextBigTutorial,
    backBigTutorial: jest.fn(async () => {}),
    runBigTutorialAction: jest.fn(async () => {}),
    pauseBigTutorial: jest.fn(async () => {}),
    restartBigTutorial: mockRestartBigTutorial,
    ...overrides,
  };
}

describe('BigTutorialOverlay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/chat?conversation=conversation-1');
    mockUseTour.mockReturnValue(tutorialState());
  });

  it('continues from a restored waiting step when Chat already finished', async () => {
    const chat = document.createElement('div');
    chat.dataset.tutorialChatStatus = 'completed';
    document.body.appendChild(chat);

    render(<BigTutorialOverlay />);

    await waitFor(() => expect(mockNextBigTutorial).toHaveBeenCalledTimes(1));
    chat.remove();
  });

  it('skips only the current step', () => {
    render(<BigTutorialOverlay />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(mockNextBigTutorial).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a confirmed fresh restart', () => {
    render(<BigTutorialOverlay />);

    fireEvent.click(screen.getByRole('button', { name: 'Restart from beginning' }));
    const dialog = screen.getByRole('dialog', { name: 'Restart Stage 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart tutorial' }));

    expect(mockRestartBigTutorial).toHaveBeenCalledTimes(1);
  });
});
