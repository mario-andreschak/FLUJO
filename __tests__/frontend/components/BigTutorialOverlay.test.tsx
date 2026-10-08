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
    chat.dataset.tutorialConversationId = 'conversation-1';
    document.body.appendChild(chat);

    render(<BigTutorialOverlay />);

    await waitFor(() => expect(mockNextBigTutorial).toHaveBeenCalledTimes(1));
    chat.remove();
  });

  it('skips only the current step', () => {
    mockUseTour.mockReturnValue(tutorialState({ bigTutorialProgress: { status: 'active', stepId: 'plain-chat', conversationId: 'conversation-1' } }));
    render(<BigTutorialOverlay />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(mockNextBigTutorial).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['wait-for-first-answer', 'wait-for-second-answer'])('keeps %s on failure and offers recovery instead of success', (stepId) => {
    const back = jest.fn();
    mockUseTour.mockReturnValue(tutorialState({
      bigTutorialProgress: { status: 'active', stepId, conversationId: 'conversation-1' },
      bigTutorialRunStatus: 'error', backBigTutorial: back,
    }));
    render(<BigTutorialOverlay />);
    expect(screen.getByRole('alert')).toHaveTextContent('could not finish');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry question' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(mockNextBigTutorial).not.toHaveBeenCalled();
  });

  it('recovers a persisted error after reload without advancing', async () => {
    render(<><div data-tutorial-conversation-id="conversation-1" data-tutorial-chat-status="error" /><BigTutorialOverlay /></>);
    expect(await screen.findByRole('button', { name: 'Retry question' })).toBeEnabled();
    expect(mockNextBigTutorial).not.toHaveBeenCalled();
  });

  it('does not mistake an old or unrelated completed conversation for the new answer', () => {
    mockUseTour.mockReturnValue(tutorialState({ bigTutorialRunStatus: 'running' }));
    render(<><div data-tutorial-conversation-id="conversation-1" data-tutorial-chat-status="completed" /><BigTutorialOverlay /></>);
    expect(mockNextBigTutorial).not.toHaveBeenCalled();
  });

  it('offers a confirmed fresh restart', () => {
    render(<BigTutorialOverlay />);

    fireEvent.click(screen.getByRole('button', { name: 'Restart from beginning' }));
    const dialog = screen.getByRole('dialog', { name: 'Restart Stage 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart tutorial' }));

    expect(mockRestartBigTutorial).toHaveBeenCalledTimes(1);
  });
});
