/**
 * The goal bar above the message box in a chat with an agent (#1225): what the
 * goal is, where it stands, and buttons to pause, resume and clear it.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatGoal } from '@/shared/types/chatGoal';

const getChatGoal = jest.fn<Promise<ChatGoal | null>, [string]>();
const updateChatGoal = jest.fn();
const clearChatGoal = jest.fn();
jest.mock('@/frontend/services/chat', () => ({
  chatService: {
    getChatGoal: (...args: [string]) => getChatGoal(...args),
    updateChatGoal: (...args: unknown[]) => updateChatGoal(...args),
    clearChatGoal: (...args: unknown[]) => clearChatGoal(...args),
  },
}));

import ChatGoalBar from '@/frontend/components/Chat/ChatGoalBar';

const goal = (overrides: Partial<ChatGoal> = {}): ChatGoal => ({
  id: 'goal_1', conversationId: 'conv-1', text: 'Make every test pass', state: 'active', createdAt: 1, updatedAt: 1,
  rounds: 2, quietRounds: 0, failedRounds: 0, ...overrides,
});

beforeEach(() => {
  getChatGoal.mockReset();
  updateChatGoal.mockReset().mockResolvedValue({ goal: null, running: false });
  clearChatGoal.mockReset().mockResolvedValue(null);
});

describe('ChatGoalBar', () => {
  it('shows nothing when the chat has no goal', async () => {
    getChatGoal.mockResolvedValue(null);
    render(<ChatGoalBar conversationId="conv-1" refreshKey="a" />);
    await waitFor(() => expect(getChatGoal).toHaveBeenCalledWith('conv-1'));
    expect(screen.queryByRole('region', { name: 'Chat goal' })).toBeNull();
  });

  it('shows an active goal with its round and lets the person pause or clear it', async () => {
    getChatGoal.mockResolvedValue(goal());
    render(<ChatGoalBar conversationId="conv-1" refreshKey="a" />);
    const region = await screen.findByRole('region', { name: 'Chat goal' });
    expect(region).toHaveTextContent('Goal: Make every test pass');
    expect(screen.getByRole('status')).toHaveTextContent('Working on it, round 2');

    getChatGoal.mockResolvedValue(goal({ state: 'paused', pause: { reason: 'person', at: 2 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
    await waitFor(() => expect(updateChatGoal).toHaveBeenCalledWith('conv-1', 'pause'));
    expect(await screen.findByRole('button', { name: 'Resume goal' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Paused by you');

    getChatGoal.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
    await waitFor(() => expect(clearChatGoal).toHaveBeenCalledWith('conv-1'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Chat goal' })).toBeNull());
  });

  it('says why a goal waits, and that it is reached', async () => {
    getChatGoal.mockResolvedValue(goal({ state: 'paused', pause: { reason: 'blocked', detail: 'I need the key', at: 2 } }));
    const { rerender } = render(<ChatGoalBar conversationId="conv-1" refreshKey="a" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting for you: I need the key');

    getChatGoal.mockResolvedValue(goal({ state: 'achieved' }));
    rerender(<ChatGoalBar conversationId="conv-1" refreshKey="b" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reached'));
    expect(screen.queryByRole('button', { name: 'Pause goal' })).toBeNull();
  });

  it('reads an active goal again and reports a new round, so the chat shows the new turn', async () => {
    jest.useFakeTimers();
    try {
      const onProgress = jest.fn();
      getChatGoal.mockResolvedValue(goal({ rounds: 1 }));
      const { rerender } = render(<ChatGoalBar conversationId="conv-1" refreshKey="a" onProgress={onProgress} />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('status')).toHaveTextContent('round 1');

      getChatGoal.mockResolvedValue(goal({ rounds: 2 }));
      await act(async () => { jest.advanceTimersByTime(4_000); await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('status')).toHaveTextContent('round 2');
      expect(onProgress).toHaveBeenCalledTimes(1);

      // The chat moved on (its reply ended) and the goal was reached meanwhile.
      getChatGoal.mockResolvedValue(goal({ rounds: 3, state: 'achieved' }));
      rerender(<ChatGoalBar conversationId="conv-1" refreshKey="b" onProgress={onProgress} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('status')).toHaveTextContent('Reached');
      expect(onProgress).toHaveBeenCalledTimes(2);

      // Another chat's goal is not progress of this one.
      getChatGoal.mockResolvedValue(goal({ conversationId: 'conv-2', rounds: 9 }));
      rerender(<ChatGoalBar conversationId="conv-2" refreshKey="b" onProgress={onProgress} />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(onProgress).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
