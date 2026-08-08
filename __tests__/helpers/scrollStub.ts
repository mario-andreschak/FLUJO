/**
 * Shared jsdom scroll stubs (#376).
 *
 * jsdom computes no layout: `scrollHeight`/`clientHeight` are always 0 and
 * `scrollTop` is a no-op, so any scroll logic is untestable out of the box.
 * These helpers make the geometry configurable and `scrollTop` a real
 * read/write property, which is exactly what `useScrollRestoration`'s test has
 * been doing by hand — the scroll-nav suites reuse it from here.
 */

export interface ScrollGeometry {
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollStubHandle {
  /** Change the reported geometry (e.g. to simulate a non-scrollable surface). */
  setGeometry(next: Partial<ScrollGeometry>): void;
  /** Restore the original prototype descriptors. */
  restore(): void;
}

const scrollTopStore = new WeakMap<object, number>();

export function installScrollStubs(initial: Partial<ScrollGeometry> = {}): ScrollStubHandle {
  const geometry: ScrollGeometry = {
    scrollHeight: initial.scrollHeight ?? 1000,
    clientHeight: initial.clientHeight ?? 200,
  };

  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const scrollToOriginal = (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;

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
      return geometry.scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return geometry.clientHeight;
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

  return {
    setGeometry(next) {
      if (typeof next.scrollHeight === 'number') geometry.scrollHeight = next.scrollHeight;
      if (typeof next.clientHeight === 'number') geometry.clientHeight = next.clientHeight;
    },
    restore() {
      if (scrollTopDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTop', scrollTopDescriptor);
      if (scrollHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
      if (clientHeightDescriptor) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeightDescriptor);
      (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollToOriginal;
    },
  };
}

/** Give an element a fixed bounding rect (jsdom returns all-zero rects). */
export function stubRect(el: HTMLElement, top: () => number): void {
  el.getBoundingClientRect = () =>
    ({ top: top(), bottom: top(), left: 0, right: 0, width: 0, height: 0, x: 0, y: top(), toJSON: () => ({}) }) as DOMRect;
}

/** Replace `window.matchMedia` so media-query dependent code is deterministic. */
export function stubMatchMedia(matcher: (query: string) => boolean): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matcher(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  return () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: original });
  };
}
