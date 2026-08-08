/**
 * Chat scroll navigation tests (issue #376).
 *
 * The chat transcript wiring lives in `useChatScrollNav`, so the hook is
 * exercised through a small harness that mirrors how `Chat/index.tsx` mounts it
 * (scroll container + message bubbles + ScrollNavCluster). Verified here:
 * reachability from the default bottom position, the three actions, the
 * sticky-autoscroll contract during streaming, and the mobile auto-hide.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useChatScrollNav } from '@/frontend/components/Chat/hooks/useChatScrollNav';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { installScrollStubs, stubRect } from '../../helpers/scrollStub';

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 200;
const MESSAGE_OFFSETS = [0, 300, 600];

let stubs: ReturnType<typeof installScrollStubs>;

beforeAll(() => {
  stubs = installScrollStubs({ scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT });
});

afterAll(() => {
  stubs.restore();
});

interface HarnessProps {
  messages: string[];
  autoHideEnabled?: boolean;
  idleMs?: number;
}

function ChatHarness({ messages, autoHideEnabled, idleMs }: HarnessProps) {
  const { t } = useI18n();
  const nav = useChatScrollNav({ conversationId: 'conv-1', messages, autoHideEnabled, idleMs });

  return (
    <div>
      <div data-testid="scroller" {...nav.containerProps}>
        {messages.map(id => (
          <div key={id} data-ask-flujo-message-id={id}>
            {id}
          </div>
        ))}
      </div>
      <ScrollNavCluster
        show={nav.show}
        actions={nav.actions}
        disabled={nav.disabled}
        onAction={nav.onAction}
        positionMode="absolute"
        labels={{
          top: t('chat.page.scrollTop'),
          up: t('chat.page.scrollLastMessage'),
          bottom: t('chat.page.scrollLatest'),
        }}
      />
    </div>
  );
}

function renderChat(props: HarnessProps) {
  const utils = render(<ChatHarness {...props} />);
  const container = utils.getByTestId('scroller') as HTMLDivElement;

  stubRect(container, () => 0);
  Array.from(container.querySelectorAll<HTMLElement>('[data-ask-flujo-message-id]')).forEach((el, index) => {
    stubRect(el, () => (MESSAGE_OFFSETS[index] ?? 900) - container.scrollTop);
  });

  return { ...utils, container };
}

const LABEL_TOP = 'Scroll to top of loaded messages';
const LABEL_LAST = 'Scroll to beginning of last message';
const LABEL_LATEST = 'Scroll to latest messages';

describe('chat scroll navigation (#376)', () => {
  it('keeps every control reachable while pinned to the bottom', () => {
    renderChat({ messages: ['m1', 'm2', 'm3'] });

    // Mount pins the transcript to the newest message — the historical bug was
    // that the controls only appeared *after* scrolling up, so "scroll to top"
    // could never be reached from here.
    expect(screen.getByRole('button', { name: LABEL_TOP })).toBeEnabled();
    expect(screen.getByRole('button', { name: LABEL_LAST })).toBeEnabled();
    expect(screen.getByRole('button', { name: LABEL_LATEST })).toBeDisabled();
  });

  it('hides the cluster when the transcript does not overflow', () => {
    stubs.setGeometry({ scrollHeight: CLIENT_HEIGHT, clientHeight: CLIENT_HEIGHT });
    try {
      renderChat({ messages: ['m1'] });
      expect(screen.queryByRole('button', { name: LABEL_TOP })).toBeNull();
    } finally {
      stubs.setGeometry({ scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT });
    }
  });

  it('scrolls to the top of the loaded window', () => {
    const { container } = renderChat({ messages: ['m1', 'm2', 'm3'] });
    expect(container.scrollTop).toBe(SCROLL_HEIGHT);

    fireEvent.click(screen.getByRole('button', { name: LABEL_TOP }));

    expect(container.scrollTop).toBe(0);
  });

  it('scrolls to the beginning of the last message, then walks upwards', () => {
    const { container } = renderChat({ messages: ['m1', 'm2', 'm3'] });

    fireEvent.click(screen.getByRole('button', { name: LABEL_LAST }));
    expect(container.scrollTop).toBe(600);

    fireEvent.click(screen.getByRole('button', { name: LABEL_LAST }));
    expect(container.scrollTop).toBe(300);
  });

  it('re-pins to the newest message and clears the button', () => {
    const { container } = renderChat({ messages: ['m1', 'm2', 'm3'] });

    fireEvent.click(screen.getByRole('button', { name: LABEL_TOP }));
    expect(container.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: LABEL_LATEST }));
    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
    expect(screen.getByRole('button', { name: LABEL_LATEST })).toBeDisabled();
  });

  it('stops sticky autoscroll after an upward jump so streaming cannot yank the reader down', () => {
    const messages = ['m1', 'm2', 'm3'];
    const { container, rerender } = renderChat({ messages });

    fireEvent.click(screen.getByRole('button', { name: LABEL_TOP }));
    expect(container.scrollTop).toBe(0);

    // Simulate a streaming update (the reducer hands over a new array).
    rerender(<ChatHarness messages={[...messages, 'm4']} />);

    expect(container.scrollTop).toBe(0);
  });

  it('keeps following new content while pinned to the bottom', () => {
    const messages = ['m1', 'm2', 'm3'];
    const { container, rerender } = renderChat({ messages });

    fireEvent.click(screen.getByRole('button', { name: LABEL_LATEST }));
    act(() => {
      container.scrollTop = 500; // content grew; the view is programmatically behind
    });

    rerender(<ChatHarness messages={[...messages, 'm4']} />);

    expect(container.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('clears sticky autoscroll when the user scrolls up manually', () => {
    const messages = ['m1', 'm2', 'm3'];
    const { container, rerender } = renderChat({ messages });

    act(() => {
      container.scrollTop = 100;
      fireEvent.scroll(container);
    });
    expect(screen.getByRole('button', { name: LABEL_LATEST })).toBeEnabled();

    rerender(<ChatHarness messages={[...messages, 'm4']} />);
    expect(container.scrollTop).toBe(100);
  });

  it('auto-hides on mobile after the idle delay and reappears on scroll', () => {
    jest.useFakeTimers();
    try {
      const { container } = renderChat({ messages: ['m1', 'm2', 'm3'], autoHideEnabled: true, idleMs: 500 });

      expect(screen.getByRole('button', { name: LABEL_TOP })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(screen.queryByRole('button', { name: LABEL_TOP })).toBeNull();

      act(() => {
        container.scrollTop = 400;
        fireEvent.scroll(container);
      });
      expect(screen.getByRole('button', { name: LABEL_TOP })).toBeInTheDocument();
    } finally {
      act(() => {
        jest.runOnlyPendingTimers();
      });
      jest.useRealTimers();
    }
  });
});
