import React from 'react';
import { act, render } from '@testing-library/react';
import LiveRunIndicator from '@/frontend/components/Chat/LiveRunIndicator';
import {
  getWorkingMessage,
  WORKING_MESSAGE_COUNT,
  WORKING_MESSAGE_INTERVAL_MS,
} from '@/frontend/components/Chat/workingMessages';

describe('working chat messages', () => {
  it('provides a genuinely large message space', () => {
    expect(WORKING_MESSAGE_COUNT).toBeGreaterThan(13_000_000);
  });

  it('does not repeat a message in a long normal run', () => {
    const messages = Array.from({ length: 10_000 }, (_, index) => (
      getWorkingMessage(index, 1_785_500_123_456)
    ));

    expect(new Set(messages).size).toBe(messages.length);
    expect(messages.every(message => message.endsWith('…'))).toBe(true);
    expect(messages.every(message => !message.includes('undefined'))).toBe(true);
  });

  it('changes sentence shape and regularly surfaces coincidence jokes', () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => getWorkingMessage(index, 333));
    const openingWords = messages.slice(0, 48).map(message => message.split(' ')[0]);
    const coincidenceJokes = messages.filter(message => (
      /\b(just as|precisely|exact|coincidence|moments? before|one minute after|seconds before)\b/i.test(message)
    ));

    expect(new Set(openingWords).size).toBeGreaterThan(30);
    expect(coincidenceJokes.length).toBeGreaterThan(150);
  });

  it('is stable within a run but starts different runs on different routes', () => {
    const firstRun = Array.from({ length: 100 }, (_, index) => getWorkingMessage(index, 111));
    const repeatedRun = Array.from({ length: 100 }, (_, index) => getWorkingMessage(index, 111));
    const secondRun = Array.from({ length: 100 }, (_, index) => getWorkingMessage(index, 222));

    expect(repeatedRun).toEqual(firstRun);
    expect(secondRun).not.toEqual(firstRun);
  });

  it('keeps each message visible for ten seconds', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
    const startedAt = Date.now();
    const { container, unmount } = render(
      <LiveRunIndicator
        liveStats={{ totalTokens: 123, activeNode: null, startedAt, lastEventAt: startedAt }}
        onStop={() => undefined}
      />,
    );
    const message = () => container.querySelector('[aria-live="polite"]')?.textContent;
    const initialMessage = message();

    expect(WORKING_MESSAGE_INTERVAL_MS).toBe(10_000);

    act(() => { jest.advanceTimersByTime(9_000); });
    expect(message()).toBe(initialMessage);

    act(() => { jest.advanceTimersByTime(1_000); });
    expect(message()).not.toBe(initialMessage);

    unmount();
    jest.useRealTimers();
  });
});
