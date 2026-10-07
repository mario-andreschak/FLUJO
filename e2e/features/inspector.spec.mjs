import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createFeatureBrowserEnvironment } from '../../scripts/feature-surface-acceptance/browser-environment.mjs';

const labelName = label => new RegExp('^' + label + '(?: |$)');
let environment;
const toolNames = Array.from({ length: 128 }, (_, index) => `fixture_tool_${String(index + 1).padStart(3, '0')}`);
const locales = [
  ['en', 'Your first AI + app agent', 'Saved app to inspect', 'Inspect and test tools', 'Select tool'],
  ['es', 'Tu primer agente con IA y una aplicación', 'Aplicación guardada para inspeccionar', 'Inspeccionar y probar herramientas', 'Seleccionar herramienta'],
  ['de', 'Dein erster Agent mit KI und App', 'Gespeicherte App prüfen', 'Werkzeuge prüfen und testen', 'Tool auswählen'],
  ['fr', 'Votre premier agent avec IA et application', 'Application enregistrée à inspecter', 'Inspecter et tester les outils', 'Sélectionner un outil'],
  ['it', 'Il tuo primo agente con IA e app', 'App salvata da esaminare', 'Esamina e prova gli strumenti', 'Seleziona strumento'],
  ['pt', 'Seu primeiro agente com IA e aplicativo', 'Aplicativo salvo para inspecionar', 'Inspecionar e testar ferramentas', 'Selecionar ferramenta'],
  ['zh-CN', '创建首个 AI 与应用智能体', '选择要检查的已保存应用', '检查并测试工具', '选择工具'],
];

test.beforeAll(async () => {
  environment = await createFeatureBrowserEnvironment({ applicationRoot: process.env.FEATURE_BROWSER_APP_DIR });
});
test.afterAll(async ({}, testInfo) => {
  if (!environment) return;
  try { await environment.verifyServerSelection(); }
  finally {
    try { await environment.close(); }
    finally { await testInfo.attach('final-owned-environment', { body: JSON.stringify(environment.snapshot(), null, 2), contentType: 'application/json' }); }
  }
});

async function openInspector(page, serverName, labels = locales[0], navigate = true) {
  const [, title, savedApp, inspect] = labels;
  if (navigate) await page.goto(`${environment.baseURL}/mcp?featureTestLocale=${labels[0]}`);
  const summary = page.getByRole('button', { name: title, exact: true });
  if (await summary.getAttribute('aria-expanded') !== 'true') await summary.click();
  const detailsId = await summary.getAttribute('aria-controls');
  const guide = page.locator(`[id=${JSON.stringify(detailsId)}]`);
  await expect(guide.locator('a[href="/models"]')).toBeVisible();
  await expect(guide.locator('a[href="/flows?authoringMode=guided"]')).toBeVisible();
  await expect(guide.locator('a[href="/docs"]')).toBeVisible();
  const appSelector = page.getByRole('combobox', { name: labelName(savedApp) });
  await appSelector.click();
  await page.getByRole('option', { name: serverName, exact: true }).click();
  await expect(appSelector).toContainText(serverName);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.getByRole('button', { name: inspect, exact: true }).click();
}

async function selectTool(page, name, label = 'Select tool') {
  await page.getByRole('combobox', { name: labelName(label) }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function appMount(page) {
  for (const frame of page.frames()) {
    try {
      const mount = frame.locator('#mount');
      if (await mount.count()) return { frame, id: await mount.textContent() };
    } catch { /* A frame may detach between enumeration and its DOM read. */ }
  }
  return null;
}

async function configure(mode, delayMs) {
  const response = await fetch(`${environment.fixture.url}/control`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fixture-control': environment.fixture.controlToken },
    body: JSON.stringify({ mode, ...(delayMs === undefined ? {} : { delayMs }) }) });
  expect(response.status).toBe(200);
}

test('128 tools and real draft/result/App retention with explicit execution', async ({ page, browser }, testInfo) => {
  const observations = { scope: 'automated synthetic-tool browser observation', steps: [],
    runtime: { platform: os.platform(), release: os.release(), architecture: os.arch(),
      browserVersion: browser.version(), project: testInfo.project.name, viewport: page.viewportSize() },
    humanReview: 'not_evaluated', realProviderAgent: 'not_evaluated',
    declaredSourceSha: process.env.FEATURE_BROWSER_SOURCE_SHA ?? null };
  const step = async (name, action) => test.step(name, async () => {
    await action();
    observations.steps.push({ name, completedAt: new Date().toISOString(), receipt: environment.fixture.state.snapshot() });
  });
  try {
    await step('all 128 menu entries reached by keyboard without invoking a tool', async () => {
      await openInspector(page, 'Feature HTTP fixture');
      const selector = page.getByRole('combobox', { name: labelName('Select tool') });
      await selector.click();
      const options = page.getByRole('option');
      await expect(options).toHaveCount(129);
      expect((await options.allTextContents()).slice(1)).toEqual(toolNames);
      await page.getByRole('listbox').press('Home');
      for (const name of toolNames) {
        await page.keyboard.press('ArrowDown');
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(name);
      }
      await page.keyboard.press('Enter');
      await expect(selector).toHaveText('fixture_tool_128');
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
    });
    await step('explicit first-page Test and real sandboxed App initialization', async () => {
      await selectTool(page, 'fixture_tool_001');
      await page.getByRole('textbox', { name: 'url *', exact: true }).fill('https://example.invalid/feature-browser');
      await page.getByRole('textbox', { name: 'options (JSON object)', exact: true }).fill('{"marker":"early-receipt","nested":{"depth":2}}');
      expect(environment.fixture.state.snapshot().toolCalls).toBe(0);
      await page.getByRole('button', { name: 'Test tool', exact: true }).click();
      await expect.poll(() => environment.fixture.state.snapshot().acceptedCalls).toBe(1);
      const earlyArguments = { url: 'https://example.invalid/feature-browser', options: { marker: 'early-receipt', nested: { depth: 2 } } };
      expect(environment.fixture.state.snapshot().recentCalls.at(-1).argumentsSha256)
        .toBe(createHash('sha256').update(JSON.stringify(earlyArguments)).digest('hex'));
      await expect(page.getByText('early-receipt', { exact: false }).first()).toBeVisible();
      // The seeded server explicitly enables Apps; the fresh profile uses the
      // default visible launch behavior. Consent-policy variants are separate.
      await expect.poll(async () => (await appMount(page))?.id ?? '').toMatch(/^[a-f0-9-]{36}$/);
      const mounted = await appMount(page);
      await expect(mounted.frame.getByRole('status')).toContainText('Initialized');
      observations.mountId = mounted.id;
      expect(environment.fixture.state.snapshot().toolCalls).toBe(1);
    });
    await step('unfinished draft blocks Test; delayed and failed refresh preserve actual nodes and App mount', async () => {
      const options = page.getByRole('textbox', { name: 'options (JSON object)', exact: true });
      await options.fill('{"marker":');
      const node = await options.elementHandle();
      await expect(page.getByRole('button', { name: 'Test tool', exact: true })).toBeDisabled();
      await configure('delay', 1000);
      const refresh = page.getByRole('button', { name: 'Refresh tools', exact: true });
      await refresh.click();
      await expect(page.getByRole('status').filter({ hasText: 'Loading tools' })).toBeVisible();
      await options.focus();
      await expect(options).toBeFocused();
      await expect(options).toHaveValue('{"marker":');
      await expect(refresh).toBeEnabled();
      expect(await node.evaluate(element => element.isConnected)).toBe(true);
      expect((await appMount(page))?.id).toBe(observations.mountId);
      for (const mode of ['fail-second-page', 'cycle']) {
        await configure(mode);
        await refresh.click();
        await expect(page.getByRole('alert').filter({ hasText: 'Using cached tools' })).toBeVisible();
        await expect(options).toHaveValue('{"marker":');
        expect(await node.evaluate(element => element.isConnected)).toBe(true);
        expect((await appMount(page))?.id).toBe(observations.mountId);
        await expect(page.getByText('early-receipt', { exact: false }).first()).toBeVisible();
        await page.getByRole('combobox', { name: labelName('Select tool') }).click();
        await expect(page.getByRole('option')).toHaveCount(129);
        await page.keyboard.press('Escape');
      }
      expect(environment.fixture.state.snapshot().toolCalls).toBe(1);
      await configure('normal');
      await refresh.click();
      await expect(refresh).toBeEnabled();
      await expect(page.getByRole('alert').filter({ hasText: 'Using cached tools' })).toHaveCount(0);
    });
    await step('different tool clears drafts; last-page arguments are dispatched exactly once', async () => {
      await selectTool(page, 'fixture_tool_128');
      await expect(page.getByRole('textbox', { name: 'options (JSON object)', exact: true })).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Test tool', exact: true })).toBeEnabled();
      await page.getByRole('textbox', { name: 'element *', exact: true }).fill('late fixture receipt');
      await page.getByRole('textbox', { name: 'ref *', exact: true }).fill('late-marker');
      await page.getByRole('textbox', { name: 'modifiers (JSON array)', exact: true }).fill('["Shift"]');
      await page.getByRole('textbox', { name: 'options (JSON object)', exact: true }).fill('{"marker":"late-receipt"}');
      await page.getByRole('combobox', { name: labelName('button') }).click();
      await page.getByRole('option', { name: 'right', exact: true }).click();
      const enabled = page.getByRole('checkbox', { name: 'enabled', exact: true });
      await enabled.check();
      await enabled.uncheck();
      await page.getByRole('button', { name: 'Test tool', exact: true }).click();
      await expect.poll(() => environment.fixture.state.snapshot().acceptedCalls).toBe(2);
      const receipt = environment.fixture.state.snapshot().recentCalls.at(-1);
      expect(receipt.toolName).toBe('fixture_tool_128');
      const expectedArguments = { element: 'late fixture receipt', ref: 'late-marker', modifiers: ['Shift'],
        options: { marker: 'late-receipt' }, button: 'right', enabled: false };
      expect(receipt.argumentsSha256).toBe(createHash('sha256').update(JSON.stringify(expectedArguments)).digest('hex'));
      await expect(page.getByText('late-receipt', { exact: false }).first()).toBeVisible();
    });
    await step('successful empty discovery clears the selector and a different server cannot inherit results', async () => {
      await configure('empty');
      await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
      await page.getByRole('combobox', { name: labelName('Select tool') }).click();
      await expect(page.getByRole('option')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await configure('normal');
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await openInspector(page, 'Feature SSE fixture', locales[0], false);
      await expect(page.getByText('late-receipt', { exact: false })).toHaveCount(0);
      await page.getByRole('combobox', { name: labelName('Select tool') }).click();
      await expect(page.getByRole('option')).toHaveCount(129);
      await page.getByRole('option', { name: 'fixture_tool_128', exact: true }).click();
      await expect.poll(async () => (await page.getByRole('textbox', { name: 'ref *', exact: true }).locator('[data-slate-string]').allTextContents()).join('')).toBe('');
      expect(environment.fixture.state.snapshot().toolCalls).toBe(2);
    });
    await page.screenshot({ path: testInfo.outputPath('final-inspector.png'), fullPage: true });
  } finally {
    await configure('normal').catch(() => undefined);
    await testInfo.attach('browser-observations', { body: JSON.stringify({ ...observations, environment: environment.snapshot() }, null, 2), contentType: 'application/json' });
  }
});

test('seven rendered guide/tool-selector languages without implicit execution', async ({ page, browser }, testInfo) => {
  const before = environment.fixture.state.snapshot().toolCalls;
  const observations = [];
  try {
    await page.addInitScript(() => {
      const locale = new URL(location.href).searchParams.get('featureTestLocale');
      if (locale) localStorage.setItem('flujo.locale', locale);
    });
    for (const labels of locales) {
      await openInspector(page, 'Feature HTTP fixture', labels);
      await expect(page.locator('html')).toHaveAttribute('data-locale', labels[0]);
      await page.getByRole('combobox', { name: labelName(labels[4]) }).click();
      await expect(page.getByRole('option')).toHaveCount(129);
      await page.keyboard.press('Escape');
      observations.push({ locale: labels[0], completedAt: new Date().toISOString() });
    }
    expect(environment.fixture.state.snapshot().toolCalls).toBe(before);
  } finally {
    await testInfo.attach('language-observations', { body: JSON.stringify({ scope: 'rendered labels and menu availability; not linguistic/human review',
      runtime: { platform: os.platform(), release: os.release(), architecture: os.arch(), browserVersion: browser.version(),
        project: testInfo.project.name, viewport: page.viewportSize() }, observations }, null, 2), contentType: 'application/json' });
  }
});
