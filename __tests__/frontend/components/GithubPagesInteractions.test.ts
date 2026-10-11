import { readFileSync } from 'node:fs';
import path from 'node:path';

const site = path.resolve(__dirname, '../../../githubpages');
const script = readFileSync(path.join(site, 'assets/site.js'), 'utf8');
const imagePages = ['/start/', '/guides/website-builder/', '/guides/first-agent/', '/guides/persona/'];
let wideScreen: EventTarget;
let documentListeners: jest.SpyInstance;
let writeText: jest.Mock;
const dialogPrototype = HTMLDialogElement.prototype;
const originalShow = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
const originalClose = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing site element: ${selector}`);
  return found;
}

function boot(route = '/guides/first-agent/', dialogSupported = true) {
  history.replaceState(null, '', `${location.origin}${route}`);
  document.documentElement.innerHTML = readFileSync(
    path.join(site, route.slice(1), 'index.html'), 'utf8',
  );
  document.documentElement.className = '';
  expect(document.querySelector('script[src="/assets/site.js"]')).not.toBeNull();
  Object.defineProperty(dialogPrototype, 'showModal', {
    configurable: true,
    value: dialogSupported ? jest.fn(function (this: HTMLDialogElement) {
      this.open = true;
      this.querySelector<HTMLButtonElement>('button')?.focus();
    }) : undefined,
  });
  Object.defineProperty(dialogPrototype, 'close', {
    configurable: true,
    value: jest.fn(function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    }),
  });
  window.eval(script);
}

function dialog() {
  return element<HTMLDialogElement>('.screenshot-dialog');
}

function dialogState() {
  return {
    open: dialog().open,
    source: element<HTMLImageElement>('.screenshot-dialog img').src,
    alt: element<HTMLImageElement>('.screenshot-dialog img').alt,
    caption: element('#screenshot-caption').textContent,
    original: element<HTMLAnchorElement>('.original-link').href,
    locked: document.body.classList.contains('no-scroll'),
    focus: document.activeElement,
  };
}

// Observe whether the enhancement intercepts a link without making jsdom
// attempt native navigation (which it does not implement).
function intercepted(link: HTMLAnchorElement, init: MouseEventInit = {}, type = 'click') {
  let prevented = false;
  link.addEventListener(type, event => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  }, { once: true });
  link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  return prevented;
}

beforeEach(() => {
  wideScreen = new EventTarget();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn(() => wideScreen),
  });
  writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText },
  });
  documentListeners = jest.spyOn(document, 'addEventListener');
});

afterEach(() => {
  // Each evaluation installs a document-level Escape listener. Remove only
  // those added by this test so old page closures cannot affect later fixtures.
  for (const [type, listener, options] of documentListeners.mock.calls) {
    document.removeEventListener(type, listener, options);
  }
  jest.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  document.body.classList.remove('no-scroll');
});

afterAll(() => {
  for (const [object, key, descriptor] of [
    [dialogPrototype, 'showModal', originalShow],
    [dialogPrototype, 'close', originalClose],
    [navigator, 'clipboard', originalClipboard],
    [window, 'matchMedia', originalMatchMedia],
  ] as const) {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else Reflect.deleteProperty(object, key);
  }
});

describe('published guide screenshots', () => {
  test.each(imagePages)('%s opens every real image and returns focus on close', route => {
    boot(route);
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-zoom]'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const caption = link.closest('figure')?.querySelector('figcaption span')?.textContent;
      expect(intercepted(link)).toBe(true);
      expect(dialog().open).toBe(true);
      expect(element<HTMLImageElement>('.screenshot-dialog img').src).toBe(link.href);
      expect(element<HTMLImageElement>('.screenshot-dialog img').alt).toBe(link.querySelector('img')?.alt);
      expect(element('#screenshot-caption').textContent).toBe(caption);
      expect(element<HTMLAnchorElement>('.original-link').href).toBe(link.href);
      expect(element('.original-link').getAttribute('rel')).toContain('noopener');
      expect(document.body.classList.contains('no-scroll')).toBe(true);
      element<HTMLButtonElement>('.screenshot-dialog button').click();
      expect(dialog().open).toBe(false);
      expect(document.body.classList.contains('no-scroll')).toBe(false);
      expect(document.activeElement).toBe(link);
    }
  });

  test.each(['/assets/journeys/02-ai-test.png', 'assets/journeys/02-ai-test.png', './assets/journeys/02-ai-test.png'])(
    'accepts local image path %s from the site root', source => {
      boot();
      history.replaceState(null, '', '/');
      const link = element<HTMLAnchorElement>('a[data-zoom]');
      link.setAttribute('href', source);
      expect(intercepted(link)).toBe(true);
      expect(element<HTMLImageElement>('.screenshot-dialog img').src).toBe(`${location.origin}/assets/journeys/02-ai-test.png`);
      expect(dialog().open).toBe(true);
    },
  );

  test('localized image descriptions and captions are literal text', () => {
    boot('/guides/persona/');
    const text = 'ConfiguraciÃ³n â€” æ—¥æœ¬èªž ðŸ§© <img src=x onerror="alert(1)"> & "<script>"';
    const link = element<HTMLAnchorElement>('a[data-zoom]');
    link.querySelector('img')!.alt = text;
    link.closest('figure')!.querySelector('figcaption span')!.textContent = text;
    intercepted(link);
    expect(element<HTMLImageElement>('.screenshot-dialog img').alt).toBe(text);
    expect(element('#screenshot-caption').textContent).toBe(text);
    expect(element('#screenshot-caption').childElementCount).toBe(0);
  });

  test('resolves a relative image from a nested page without changing its directory', () => {
    boot('/guides/first-agent/');
    const link = element<HTMLAnchorElement>('a[data-zoom]');
    link.setAttribute('href', 'screenshot.png');
    intercepted(link);
    expect(element<HTMLImageElement>('.screenshot-dialog img').src)
      .toBe(`${location.origin}/guides/first-agent/screenshot.png`);
  });

  test('Tab wraps within the dialog, and its close event restores the trigger', () => {
    boot();
    const link = element<HTMLAnchorElement>('a[data-zoom]');
    intercepted(link);
    const close = element<HTMLButtonElement>('.screenshot-dialog button');
    const original = element<HTMLAnchorElement>('.original-link');
    close.focus();
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(original);
    original.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);
    // Browsers implement Escape through the native dialog close lifecycle.
    dialog().close();
    expect(document.activeElement).toBe(link);
    expect(document.body.classList.contains('no-scroll')).toBe(false);
  });

  test('only a click outside dialog bounds dismisses it', () => {
    boot();
    intercepted(element<HTMLAnchorElement>('a[data-zoom]'));
    jest.spyOn(dialog(), 'getBoundingClientRect').mockReturnValue({
      left: 10, right: 200, top: 10, bottom: 200,
    } as DOMRect);
    dialog().dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50 }));
    expect(dialog().open).toBe(true);
    dialog().dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1 }));
    expect(dialog().open).toBe(false);
  });

  test.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    'preserves native navigation for a valid modified click %j', modifiers => {
      boot();
      expect(intercepted(element<HTMLAnchorElement>('a[data-zoom]'), modifiers)).toBe(false);
      expect(dialog().open).toBe(false);
    },
  );
});

const hostileSources = [
  'javascript:alert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml,<svg onload="alert(1)"/>',
  'https://attacker.example/tracker.png',
  '//attacker.example/tracker.png',
  '/assets/journeys/02-ai-test.png?redirect=https://attacker.example',
  '/assets/journeys/02-ai-test.png#payload',
  '/assets/journeys/../02-ai-test.png',
  '../assets/journeys/02-ai-test.png',
  '/assets/journeys/./02-ai-test.png',
  '/assets/journeys/%2e%2e/02-ai-test.png',
  '/assets/journeys/%252e%252e/02-ai-test.png',
  '/assets/journeys/%2f%2fattacker.example.png',
  '/assets//journeys/02-ai-test.png',
  '/assets/journeys/02-ai-test.svg',
  '/assets/journeys/02-ai-test.png" onerror="alert(1)',
  ' /assets/journeys/02-ai-test.png',
  '/assets/journeys/02-ai-test.png\n',
  '/assets/journeys/02-ai-test.png\t',
  '/assets\\journeys\\02-ai-test.png',
  '', null,
];

describe.each([false, true])('screenshot URL safety with existing dialog open=%s', open => {
  test.each(hostileSources)('rejects %p without changing the viewer or its remembered trigger', source => {
    boot();
    const [first, second] = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-zoom]'));
    intercepted(first);
    if (!open) dialog().close();
    const previous = dialogState();
    if (source === null) second.removeAttribute('href');
    else second.setAttribute('href', source);
    expect(intercepted(second)).toBe(true);
    expect(dialogState()).toEqual(previous);
    if (open) {
      dialog().close();
      expect(document.activeElement).toBe(first);
    }
  });
});

test.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
  'rejects unsafe modified and auxiliary navigation %j', modifiers => {
    boot();
    const link = element<HTMLAnchorElement>('a[data-zoom]');
    link.href = 'https://attacker.example/tracker.png';
    expect(intercepted(link, modifiers)).toBe(true);
    expect(intercepted(link, modifiers, 'auxclick')).toBe(true);
    expect(dialog().open).toBe(false);
  },
);

test.each(['https://attacker.example/', '/different-directory/'])(
  'a base element pointing to %s cannot redirect a relative image or original link', baseUrl => {
  boot();
  const base = document.createElement('base');
  base.href = baseUrl;
  document.head.append(base);
  element<HTMLAnchorElement>('a[data-zoom]').setAttribute('href', 'image.png');
  expect(intercepted(element<HTMLAnchorElement>('a[data-zoom]'))).toBe(true);
  expect(dialog().open).toBe(false);
  },
);

describe('navigation and clipboard enhancements', () => {
  test('menu state, nested link clicks, Escape focus, and desktop resize stay in sync', () => {
    boot('/guides/website-builder/');
    const menu = element<HTMLButtonElement>('.menu-toggle');
    const nav = element('#site-nav');
    menu.click();
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    expect(menu.textContent).toBe('Close');
    expect(nav.classList.contains('is-open')).toBe(true);
    element<HTMLAnchorElement>('#site-nav a').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(menu.textContent).toBe('Menu');
    expect(nav.classList.contains('is-open')).toBe(false);
    menu.click();
    const nested = element<HTMLElement>('#site-nav a span');
    nested.closest('a')!.addEventListener('click', event => event.preventDefault(), { once: true });
    nested.click();
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    menu.click();
    wideScreen.dispatchEvent(Object.assign(new Event('change'), { matches: true }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(nav.classList.contains('is-open')).toBe(false);
    wideScreen.dispatchEvent(Object.assign(new Event('change'), { matches: false }));
    expect(menu.getAttribute('aria-expanded')).toBe('false');
  });

  test.each(['/start/', '/guides/website-builder/', '/guides/first-agent/'])('%s copies each actual command or URL and announces success in its own block', async route => {
    boot(route);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.copy-button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const target = document.getElementById(button.dataset.copyTarget!)!;
      button.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenLastCalledWith(target.textContent!.trim());
      expect(button.textContent).toBe('Copied');
      expect(button.closest('.code-block')!.querySelector('[role="status"]')!.textContent)
        .toBe('Command copied to your clipboard.');
    }
    expect(writeText).toHaveBeenCalledTimes(buttons.length);
  });

  test('copy preserves interior newlines and literal characters without updating another block', async () => {
    boot();
    const [first, second] = Array.from(document.querySelectorAll<HTMLButtonElement>('.copy-button'));
    const target = document.getElementById(first.dataset.copyTarget!)!;
    target.textContent = '  first <value> & "quoted"\nsecond line  ';
    first.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('first <value> & "quoted"\nsecond line');
    expect(second.textContent).toBe('Copy');
    expect(second.closest('.code-block')!.querySelector('[role="status"]')!.textContent).toBe('');
  });

  test.each(['unavailable', 'rejected'])('copy %s selects the command and announces recovery', async mode => {
    boot();
    if (mode === 'unavailable') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    else writeText.mockRejectedValueOnce(new Error('Permission denied'));
    const button = element<HTMLButtonElement>('.copy-button');
    const target = document.getElementById(button.dataset.copyTarget!)!;
    button.click();
    await Promise.resolve();
    expect(window.getSelection()?.toString()).toBe(target.textContent);
    expect(button.textContent).toBe('Select & copy');
    const status = button.closest('.code-block')!.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('Automatic copy is unavailable.');
    expect(status.textContent).toContain('copy it with your keyboard or touch menu');
  });

  test('missing copy targets do not throw, call the clipboard, or announce false success', async () => {
    boot();
    const button = element<HTMLButtonElement>('.copy-button');
    button.dataset.copyTarget = 'missing-command';
    button.click();
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Copy');
    expect(button.closest('.code-block')!.querySelector('[role="status"]')!.textContent).toBe('');
  });

  test('unsupported dialogs retain real image links, URL safety, navigation and copying', async () => {
    boot('/guides/first-agent/', false);
    expect(document.querySelector('.screenshot-dialog')).toBeNull();
    const link = element<HTMLAnchorElement>('a[data-zoom]');
    expect(intercepted(link)).toBe(false);
    link.href = 'javascript:alert(1)';
    expect(intercepted(link)).toBe(true);
    element<HTMLButtonElement>('.menu-toggle').click();
    expect(element('.menu-toggle').getAttribute('aria-expanded')).toBe('true');
    element<HTMLButtonElement>('.copy-button').click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalled();
  });
});
