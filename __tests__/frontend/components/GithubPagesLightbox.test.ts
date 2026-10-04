import { readFileSync } from 'node:fs';
import path from 'node:path';

const page = readFileSync(path.resolve(__dirname, '../../../githubpages/index.html'), 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('Landing page script is missing');

function element<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing landing page element: ${selector}`);
  return found;
}

function click(selector: string) {
  element<HTMLElement>(selector).click();
}

function closeLightbox() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

beforeEach(() => {
  // Evaluate the actual page script in the Jest jsdom window. No image/network
  // resources are loaded; only the canvas and animation APIs need stubs.
  document.documentElement.innerHTML = page;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: jest.fn(() => ({ matches: true })),
  });
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: jest.fn(),
    createRadialGradient: () => ({ addColorStop: jest.fn() }),
    fillRect: jest.fn(),
  } as unknown as CanvasRenderingContext2D);
  window.eval(script);
});

afterEach(() => {
  jest.restoreAllMocks();
  document.body.style.overflow = '';
});

test('every gallery screenshot opens with its original caption and closes with Escape', () => {
  const shots = document.querySelectorAll<HTMLElement>('.shot');
  expect(shots).toHaveLength(9);
  for (const shot of shots) {
    shot.click();
    expect(element('#lightbox').classList.contains('open')).toBe(true);
    expect(element('#lightboxImg').getAttribute('src')).toBe(shot.getAttribute('data-full'));
    expect(element('#lightboxImg').getAttribute('alt')).toBe(shot.getAttribute('data-caption'));
    expect(element('#lightboxCaption').textContent).toBe(shot.getAttribute('data-caption'));
    expect(document.body.style.overflow).toBe('hidden');
    closeLightbox();
    expect(element('#lightbox').classList.contains('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  }
  expect(element('#app-version').textContent).toBe('v3.46.3');
});

test('all feature screenshots, keyboard selection and connected feature buttons still work', () => {
  const nodes = document.querySelectorAll<HTMLElement>('.orb-node');
  expect(nodes).toHaveLength(8);
  for (const node of nodes) {
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(element('#orbCard').classList.contains('show')).toBe(true);
    expect(element('#orbCardBody h3').textContent).toBe(node.getAttribute('aria-label'));
    const shot = element<HTMLButtonElement>('.shot-link');
    shot.click();
    expect(element('#lightbox').classList.contains('open')).toBe(true);
    expect(element('#lightboxImg').getAttribute('src')).toBe(shot.getAttribute('data-img'));
    expect(element('#lightboxCaption').textContent).toBe(node.getAttribute('aria-label'));
    closeLightbox();
    const connected = element<HTMLButtonElement>('.rel-chip');
    const relatedId = Number(connected.getAttribute('data-rel'));
    connected.click();
    expect(element('#orbCardBody h3').textContent).toBe(nodes[relatedId].getAttribute('aria-label'));
    click('#ring1');
    expect(element('#orbCard').classList.contains('show')).toBe(false);
  }
});

const hostileSources = [
  'javascript:alert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  'https://attacker.example/tracker.png',
  '//attacker.example/tracker.png',
  'img/home.png?redirect=https://attacker.example',
  'img/home.png#payload',
  'img/../home.png',
  'img/%2e%2e/home.png',
  'img/home.png" onerror="alert(1)',
  ' img/home.png',
  'img/home.png\n',
  '',
  null,
];

describe.each([
  ['gallery', '.shot', 'data-full'],
  ['feature', '.shot-link', 'data-img'],
])('%s DOM screenshot source', (_label, selector, attribute) => {
  test.each(hostileSources)('rejects %p without changing or opening the lightbox', (source) => {
    // Seed a real valid image first so rejecting a later value cannot leave a
    // payload assigned, erase the previous image or change the caption/scroll.
    click('.shot');
    closeLightbox();
    if (selector === '.shot-link') click('.orb-node');
    const shot = element<HTMLElement>(selector);
    const image = element<HTMLImageElement>('#lightboxImg');
    const previousSrc = image.getAttribute('src');
    const previousCaption = element('#lightboxCaption').textContent;
    if (source === null) shot.removeAttribute(attribute);
    else shot.setAttribute(attribute, source);
    shot.click();
    expect(image.getAttribute('src')).toBe(previousSrc);
    expect(element('#lightboxCaption').textContent).toBe(previousCaption);
    expect(element('#lightbox').classList.contains('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  test('localized captions and HTML metacharacters remain literal text', () => {
    if (selector === '.shot-link') click('.orb-node');
    const caption = 'Configuración — 日本語 🧩 <img src=x onerror="alert(1)"> & "<script>"';
    const shot = element<HTMLElement>(selector);
    shot.setAttribute(selector === '.shot-link' ? 'data-cap' : 'data-caption', caption);
    shot.click();
    expect(element('#lightbox').classList.contains('open')).toBe(true);
    expect(element('#lightboxImg').getAttribute('alt')).toBe(caption);
    expect(element('#lightboxCaption').textContent).toBe(caption);
    expect(element('#lightboxCaption').childElementCount).toBe(0);
  });
});
