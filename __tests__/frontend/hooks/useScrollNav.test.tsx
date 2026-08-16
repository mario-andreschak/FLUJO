/**
 * Unit tests for useScrollNav (issue #376).
 *
 * Covers the risk-bearing logic behind the scroll navigation cluster: position
 * state (atTop / atBottom / scrollable), top & bottom targets, anchor stepping
 * (folder headers, chat bubbles), the window-scrolling fallback and the
 * prefers-reduced-motion downgrade.
 */
import React from 'react';
import { act, render } from '@testing-library/react';
import { useScrollNav } from '@/frontend/hooks/useScrollNav';
import type { UseScrollNavResult } from '@/frontend/hooks/useScrollNav';
import { installScrollStubs, stubMatchMedia, stubRect } from '../../helpers/scrollStub';

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 200;
const ANCHOR_OFFSETS = [0, 300, 600];

let stubs: ReturnType<typeof installScrollStubs>;

beforeAll(() => {
  stubs = installScrollStubs({ scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT });
});

afterAll(() => {
  stubs.restore();
});

beforeEach(() => {
  stubs.setGeometry({ scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT });
});

interface HarnessHandle {
  nav: UseScrollNavResult<HTMLDivElement>;
}

function renderHarness(options: { attach?: boolean; anchors?: number[] } = {}) {
  const { attach = true, anchors = ANCHOR_OFFSETS } = options;
  const handle: HarnessHandle = { nav: undefined as unknown as UseScrollNavResult<HTMLDivElement> };

  function Harness() {
    const nav = useScrollNav<HTMLDivElement>({ anchorSelector: '[data-scroll-group-key]' });
    handle.nav = nav;
    return (
      <div data-testid="scroller" ref={attach ? nav.ref : undefined}>
        {anchors.map((offset, index) => (
          <div key={offset} data-scroll-group-key={`g${index}`}>
            group {index}
          </div>
        ))}
      </div>
    );
  }

  const utils = render(<Harness />);
  const container = utils.getByTestId('scroller') as HTMLDivElement;

  // jsdom has no layout: place the container at viewport top and each anchor at
  // its intended scroll offset (rects are viewport-relative, hence -scrollTop).
  stubRect(container, () => 0);
  Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-group-key]')).forEach((el, index) => {
    stubRect(el, () => anchors[index] - container.scrollTop);
  });

  act(() => {
    handle.nav.measure();
  });

  return { ...utils, container, handle };
}

describe('useScrollNav (#376)', () => {
  it('derives atTop / atBottom / scrollable from the container geometry', () => {
    const { container, handle } = renderHarness();

    expect(handle.nav.scrollable).toBe(true);
    expect(handle.nav.atTop).toBe(true);
    expect(handle.nav.atBottom).toBe(false);

    act(() => {
      container.scrollTop = 400;
      handle.nav.onScroll();
    });
    expect(handle.nav.atTop).toBe(false);
    expect(handle.nav.atBottom).toBe(false);

    act(() => {
      container.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT;
      handle.nav.onScroll();
    });
    expect(handle.nav.atBottom).toBe(true);
    expect(handle.nav.atTop).toBe(false);
  });

  it('reports scrollable === false when the content fits (cluster hidden)', () => {
    stubs.setGeometry({ scrollHeight: 200, clientHeight: 200 });
    const { handle } = renderHarness();

    expect(handle.nav.scrollable).toBe(false);
  });

  it('scrolls to the top and to the bottom of the container', () => {
    const { container, handle } = renderHarness();

    act(() => {
      container.scrollTop = 500;
      handle.nav.scrollToTop();
    });
    expect(container.scrollTop).toBe(0);

    act(() => {
      handle.nav.scrollToBottom();
    });
    expect(container.scrollTop).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
  });

  it('steps to the next anchor below and the previous anchor above', () => {
    const { container, handle } = renderHarness();

    act(() => {
      handle.nav.scrollToNextAnchor();
    });
    expect(container.scrollTop).toBe(300);

    act(() => {
      handle.nav.scrollToNextAnchor();
    });
    expect(container.scrollTop).toBe(600);

    act(() => {
      handle.nav.scrollToPreviousAnchor();
    });
    expect(container.scrollTop).toBe(300);
  });

  it('advances monotonically instead of ping-ponging on the tolerance boundary', () => {
    const { container, handle } = renderHarness();
    const seen: number[] = [];

    for (let i = 0; i < 3; i += 1) {
      act(() => {
        handle.nav.scrollToNextAnchor();
      });
      seen.push(container.scrollTop);
    }

    expect(seen).toEqual([300, 600, SCROLL_HEIGHT - CLIENT_HEIGHT]);
  });

  it('falls back to the top / bottom when no anchor lies in that direction', () => {
    const { container, handle } = renderHarness();

    act(() => {
      container.scrollTop = 100;
      handle.nav.scrollToPreviousAnchor();
    });
    expect(container.scrollTop).toBe(0);

    act(() => {
      container.scrollTop = 900;
      handle.nav.scrollToNextAnchor();
    });
    expect(container.scrollTop).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
  });

  it('pages by a viewport when the surface has no anchors at all', () => {
    const { container, handle } = renderHarness({ anchors: [] });

    act(() => {
      container.scrollTop = 0;
      handle.nav.scrollToNextAnchor();
    });
    expect(container.scrollTop).toBe(Math.round(CLIENT_HEIGHT * 0.9));

    act(() => {
      handle.nav.scrollToPreviousAnchor();
    });
    expect(container.scrollTop).toBe(0);
  });

  it('scrolls a specific element into view (chat "beginning of last message")', () => {
    const { container, handle } = renderHarness();
    const last = container.querySelectorAll<HTMLElement>('[data-scroll-group-key]')[2];

    act(() => {
      handle.nav.scrollToElement(last);
    });
    expect(container.scrollTop).toBe(600);
  });

  it('falls back to the window when no scrollable container is attached', () => {
    const scrollTo = jest.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: scrollTo });

    const { handle } = renderHarness({ attach: false });

    act(() => {
      handle.nav.scrollToTop();
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('downgrades smooth scrolling when the user prefers reduced motion', () => {
    const scrollTo = jest.fn();
    Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
    const restoreMatchMedia = stubMatchMedia(query => query.includes('prefers-reduced-motion'));

    try {
      const { handle } = renderHarness({ attach: false });

      act(() => {
        handle.nav.scrollToTop();
      });

      expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    } finally {
      restoreMatchMedia();
    }
  });
});
