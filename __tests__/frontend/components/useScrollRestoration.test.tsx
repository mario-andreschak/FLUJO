/**
 * Render tests for the useScrollRestoration hook (issue #185).
 *
 * jsdom does not compute layout, so we stub the geometry (scrollHeight /
 * clientHeight) to mark the container "scrollable", and make scrollTop a real
 * read/write property. That lets us deterministically verify the risk-bearing
 * logic: restore-on-mount, persist-on-scroll, and scrollToTop — while the true
 * end-to-end scroll behaviour is verified in the browser.
 */
import React, { useRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readUiPreference } from '@/frontend/hooks/useUiPreference';
import { useScrollRestoration } from '@/frontend/hooks/useScrollRestoration';

const SCROLL_HEIGHT = 1000;
const CLIENT_HEIGHT = 200;

let scrollTopDescriptor: PropertyDescriptor | undefined;
let scrollHeightDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;
let scrollToOriginal: unknown;
const scrollTopStore = new WeakMap<object, number>();

beforeAll(() => {
  scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  scrollToOriginal = (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;

  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: object) {
      return scrollTopStore.get(this) ?? 0;
    },
    set(this: object, value: number) {
      scrollTopStore.set(this, value);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return SCROLL_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return CLIENT_HEIGHT;
    },
  });
  (HTMLElement.prototype as unknown as { scrollTo: (arg: unknown, y?: number) => void }).scrollTo =
    function (this: HTMLElement, arg: unknown, y?: number) {
      if (typeof arg === 'object' && arg !== null) {
        this.scrollTop = (arg as { top?: number }).top ?? 0;
      } else {
        this.scrollTop = y ?? 0;
      }
    };
});

afterAll(() => {
  if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollTopDescriptor);
  if (scrollHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
  if (clientHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollToOriginal;
});

beforeEach(() => {
  window.localStorage.clear();
});

function Harness({ storageKey, threshold = 100 }: { storageKey: string; threshold?: number }) {
  const { ref, showBackToTop, scrollToTop } = useScrollRestoration<HTMLDivElement>(storageKey, { threshold });
  const domRef = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <div
        data-testid="scroller"
        ref={(node) => {
          ref.current = node;
          domRef.current = node;
        }}
        style={{ overflow: 'auto' }}
      >
        content
      </div>
      <button onClick={scrollToTop}>to-top</button>
      <span data-testid="show">{String(showBackToTop)}</span>
    </div>
  );
}

describe('useScrollRestoration (#185)', () => {
  it('restores the saved scroll position on mount', () => {
    window.localStorage.setItem('flujo-ui:scroll:test', JSON.stringify(300));
    render(<Harness storageKey="flujo-ui:scroll:test" />);
    const scroller = screen.getByTestId('scroller');
    expect(scroller.scrollTop).toBe(300);
    // Past the threshold, so the back-to-top state is on.
    expect(screen.getByTestId('show')).toHaveTextContent('true');
  });

  it('persists the scroll position to localStorage on scroll', async () => {
    render(<Harness storageKey="flujo-ui:scroll:test" />);
    const scroller = screen.getByTestId('scroller');
    act(() => {
      scroller.scrollTop = 250;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(readUiPreference<number>('flujo-ui:scroll:test', 0)).toBe(250);
    });
    expect(screen.getByTestId('show')).toHaveTextContent('true');
  });

  it('scrollToTop returns to the top and hides the button', () => {
    window.localStorage.setItem('flujo-ui:scroll:test', JSON.stringify(300));
    render(<Harness storageKey="flujo-ui:scroll:test" />);
    const scroller = screen.getByTestId('scroller');
    expect(scroller.scrollTop).toBe(300);
    act(() => {
      fireEvent.click(screen.getByText('to-top'));
    });
    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByTestId('show')).toHaveTextContent('false');
  });

  it('does nothing (no throw) when there is no saved position', () => {
    expect(() => render(<Harness storageKey="flujo-ui:scroll:empty" />)).not.toThrow();
    expect(screen.getByTestId('show')).toHaveTextContent('false');
  });
});
