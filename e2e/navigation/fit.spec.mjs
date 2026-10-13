import { test, expect, chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Run with a disposable, unlocked source-build profile supplied by
// NAVIGATION_FIXTURE_FILE. The fixture must contain a saved conversation with
// a retained prerequisite error; no provider credential or generation is needed.
let fixture;
test.beforeAll(async () => {
  fixture = JSON.parse(await fs.readFile(process.env.NAVIGATION_FIXTURE_FILE, 'utf8'));
  if (fixture.scope !== 'owned disposable navigation profile' || new URL(fixture.baseURL).hostname !== '127.0.0.1') {
    throw new Error('Navigation checks require the isolated local fixture.');
  }
});
test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem('flujo.locale', 'en'));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(fixture.chatURL);
  await expect(page.getByRole('button', { name: 'Copy link to this chat', exact: true })).toBeVisible();
  await expect(page.getByText(/Failed to resolve or decrypt API key/).first()).toBeVisible();
});

async function fit(page, testInfo, name, wholeDocument = true) {
  // Mobile overflow can expand innerWidth. Use the configured viewport as
  // the boundary, including for controls that caused that expansion.
  const viewport = page.viewportSize()?.width ?? await page.evaluate(() => innerWidth);
  const bounds = await page.locator('[data-app-navigation-toolbar]').evaluate(toolbar => ({
    layoutViewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
    height: toolbar.getBoundingClientRect().height,
    controls: [...toolbar.querySelectorAll('button,a')].filter(el => el.getBoundingClientRect().width > 0).map(el => {
      const rect = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.textContent, iconButton: el.classList.contains('MuiIconButton-root'), home: el.getAttribute('href') === '/', left: rect.left, right: rect.right, width: rect.width, height: rect.height };
    }),
  }));
  bounds.viewport = viewport;
  await testInfo.attach(name, { body: JSON.stringify(bounds), contentType: 'application/json' });
  if (wholeDocument) expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport + 1);
  for (const control of bounds.controls) {
    expect(control.name?.trim()).toBeTruthy();
    expect(control.left).toBeGreaterThanOrEqual(-1);
    expect(control.right).toBeLessThanOrEqual(bounds.viewport + 1);
    // Compact and icon controls retain their 38px hit areas. The unchanged
    // desktop workspace/help buttons use the existing 34/36px heights.
    const minimum = bounds.viewport < 600 || control.iconButton || control.home ? 37.9 : 31.9;
    expect(control.width).toBeGreaterThanOrEqual(minimum);
    expect(control.height).toBeGreaterThanOrEqual(minimum);
  }
  return bounds;
}

test('selected failure fits at 320 and 390px in every supported language', async ({ page }, testInfo) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const locale of ['en', 'es', 'de', 'fr', 'it', 'pt', 'zh-CN']) {
      await page.locator('[data-app-navigation-toolbar] button[aria-haspopup="menu"]').click();
      await page.locator(`[role="menuitem"][lang="${locale}"]`).click();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const bounds = await fit(page, testInfo, `${width}-${locale}`);
      expect(bounds.height).toBe(fixture.baselineHeight);
    }
  }
});

test('keyboard opens labelled navigation, traps focus and returns it on Escape', async ({ page }, testInfo) => {
  const trigger = page.getByRole('button', { name: 'Open navigation menu', exact: true });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: 'Primary navigation', exact: true });
  await expect(drawer).toBeVisible();
  // The modal correctly hides the underlying toolbar from assistive tech.
  const hiddenTrigger = page.getByRole('button', { name: 'Open navigation menu', exact: true, includeHidden: true });
  await expect(hiddenTrigger).toHaveAttribute('aria-expanded', 'true');
  expect(await hiddenTrigger.getAttribute('aria-controls')).toBe(await drawer.getAttribute('id'));
  const first = drawer.locator('a,button').first();
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await fit(page, testInfo, 'keyboard-return');
  const copy = page.getByRole('button', { name: 'Copy link to this chat', exact: true });
  await copy.focus();
  await page.keyboard.press('Enter');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).searchParams.get('conversation')).toBe(fixture.conversationId);
});

test('resizing and menus preserve the unsent draft and retained failure', async ({ page }, testInfo) => {
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Navigation draft survives viewport changes');
  await input.evaluate(el => { el.dataset.navigationDraftIdentity = 'original'; });
  for (const width of [390, 1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(input).toHaveText('Navigation draft survives viewport changes');
    await expect(input).toHaveAttribute('data-navigation-draft-identity', 'original');
    await fit(page, testInfo, `draft-${width}`);
  }
  await page.getByRole('button', { name: 'Open navigation menu', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Primary navigation', exact: true });
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(input).toHaveText('Navigation draft survives viewport changes');
  await expect(page.getByText(/Failed to resolve or decrypt API key/).first()).toBeVisible();
});

test('existing calendar entry remains keyboard reachable in compact navigation', async ({ page }, testInfo) => {
  const trigger = page.getByRole('button', { name: 'Open navigation menu', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const calendar = page.getByRole('dialog', { name: 'Primary navigation' }).locator('[data-tour="nav-waves"]');
  await calendar.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/automation\/waves/);
  await expect(page.getByRole('button', { name: 'Day', exact: true })).toBeVisible();
  await fit(page, testInfo, 'calendar-navigation', false);
});

test('desktop navigation retains the conversation link and its controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open navigation menu', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link to this chat', exact: true })).toBeVisible();
  await fit(page, testInfo, 'desktop');
});

test('native 200 percent browser zoom reflows the selected failure without overflow', async ({}, testInfo) => {
  const profile = path.join(testInfo.outputDir, 'zoom-profile');
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.FEATURE_BROWSER_CHROMIUM_EXECUTABLE,
    viewport: null, isMobile: false, hasTouch: false, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--window-size=656,1800', `--disable-extensions-except=${fixture.zoomExtension}`, `--load-extension=${fixture.zoomExtension}`],
  });
  try {
    await context.addInitScript(() => localStorage.setItem('flujo.locale', 'en'));
    const page = context.pages()[0];
    await page.goto(fixture.chatURL);
    await expect(page.getByRole('button', { name: 'Copy link to this chat', exact: true })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await expect.poll(async () => (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport.zoom).toBe(2);
    const metrics = await cdp.send('Page.getLayoutMetrics');
    await testInfo.attach('native-zoom', { body: JSON.stringify(metrics.cssVisualViewport), contentType: 'application/json' });
    expect(await page.evaluate(() => innerWidth)).toBeLessThanOrEqual(320);
    await fit(page, testInfo, 'native-200-percent');
    await page.screenshot({ path: path.join(testInfo.outputDir, 'native-200-percent.png'), fullPage: true });
  } finally { await context.close(); }
});
