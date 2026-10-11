#!/usr/bin/env node
// Browser acceptance for the real player. Reuses an existing Playwright install.
// Set FILM_QA_OUTPUT to retain screenshots for human legibility review.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.env.FILM_QA_OUTPUT ? resolve(process.env.FILM_QA_OUTPUT) : null;
const require = createRequire(import.meta.url);
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean);
let chromium;
for (const candidate of candidates) {
  try { ({ chromium } = require(candidate)); if (chromium) break; } catch {}
}
if (!chromium) throw new Error('Set PLAYWRIGHT_MODULE to an existing Playwright installation.');

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const path = resolve(root, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end(); }
});

const checks = [], browserErrors = [], failedResources = [], screenshots = [], frames = [], captureAssets = [];
let browser, base, captureCount = 0;
const started = performance.now();
async function check(name, run) {
  try { await run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
}
function watch(page) {
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('requestfailed', request => {
    if (request.url().startsWith(base)) failedResources.push(`${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('response', response => {
    if (response.url().startsWith(base) && response.status() >= 400)
      failedResources.push(`${response.status()} ${response.url()}`);
  });
}
async function open(page, query = '') {
  await page.goto(`${base}/film/${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.film?.ready);
  await page.evaluate(() => window.film.ready);
}
async function screenshot(page, name) {
  if (!output) return;
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(path);
}
async function inspectFrame(page, seconds, layout) {
  await page.evaluate(t => window.film.seek(t), seconds);
  const data = await page.locator('#film-canvas').evaluate(canvas => {
    const sample = document.createElement('canvas'); sample.width = 64; sample.height = 36;
    const context = sample.getContext('2d'); context.drawImage(canvas, 0, 0, 64, 36);
    const pixels = Array.from(context.getImageData(0, 0, 64, 36).data);
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) colors.add(pixels.slice(i, i + 3).join(','));
    return { pixels, colors: colors.size, width: canvas.width, height: canvas.height,
      label: canvas.getAttribute('aria-label') };
  });
  assert.ok(data.colors > 15, `Frame ${seconds} should contain visible scene detail`);
  assert.ok(data.label?.length > 15, 'Canvas needs a meaningful scene description');
  const signature = createHash('sha256').update(Buffer.from(data.pixels)).digest('hex').slice(0, 12);
  frames.push({ layout, seconds, signature, width: data.width, height: data.height });
  await screenshot(page, `${layout}-${String(seconds).padStart(2, '0')}`);
  return signature;
}

try {
  if (output) await mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  watch(page); await open(page);
  captureCount = await page.evaluate(() => window.film.captureCount ?? 0);

  await check('capture files match reviewed provenance records', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, '../docs/journeys/evidence/capture-manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'final', 'Capture provenance must be finalized');
    const CAPTURES = await page.evaluate(async () => (await import('./captures.js')).CAPTURES);
    const sources = [...new Set(Object.values(CAPTURES).flatMap(entry => [entry.src, entry.mobileSrc]).filter(Boolean))];
    for (const source of sources) {
      const absolute = resolve(root, 'film', source);
      assert.ok(absolute.startsWith(root + sep), 'Capture source must stay inside the published site');
      const file = 'githubpages/' + absolute.slice(root.length + 1).split(sep).join('/');
      const record = manifest.screenshots.find(item => item.file === file);
      assert.ok(record, `No provenance record for ${file}`);
      assert.equal(record.publicUse, 'reviewed', `${file} is not reviewed for publication`);
      const bytes = await readFile(absolute);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, record.sha256, `${file} changed since its provenance review`);
      captureAssets.push({ file, sha256, bytes: bytes.length });
    }
  });

  await check('exact 60-second timeline; no autoplay; accessible native controls', async () => {
    const state = await page.evaluate(() => ({ duration: window.film.duration,
      time: window.film.currentTime, playing: window.film.playing, scenes: window.film.scenes }));
    assert.equal(state.duration, 60); assert.equal(state.time, 0); assert.equal(state.playing, false);
    assert.equal(state.scenes[0].start, 0); assert.equal(state.scenes.at(-1).end, 60);
    for (let i = 1; i < state.scenes.length; i++) assert.equal(state.scenes[i].start, state.scenes[i - 1].end);
    const range = page.locator('#seek');
    assert.equal(await range.getAttribute('type'), 'range');
    assert.equal(await range.getAttribute('max'), '60');
    for (const id of ['play', 'replay', 'motion', 'fullscreen']) {
      const info = await page.locator(`#${id}`).evaluate(el => ({ tag: el.tagName,
        name: el.getAttribute('aria-label') || el.textContent.trim() }));
      assert.equal(info.tag, 'BUTTON'); assert.ok(info.name.length > 0);
    }
    assert.equal(await page.locator('#scene-status').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('audio, video').count(), 0, 'Film must remain silent');
  });

  await check('representative desktop scenes render distinctly and deterministically', async () => {
    const times = [3, 6.5, 9, 15, 21, 26, 33, 38, 41, 46, 52, 58];
    const signatures = [];
    for (const time of times) signatures.push(await inspectFrame(page, time, 'desktop'));
    assert.equal(new Set(signatures).size, times.length);
    assert.equal(await inspectFrame(page, 33, 'desktop-repeat'), signatures[times.indexOf(33)]);
  });

  await check('API seek clamps negative, overshoot and nonfinite values', async () => {
    for (const [input, expected] of [[-10, 0], [75, 60], [Infinity, 0], [NaN, 0], [23.5, 23.5]]) {
      const time = await page.evaluate(value => { window.film.seek(value); return window.film.currentTime; }, input);
      assert.equal(time, expected);
    }
  });

  await check('native range keyboard and focused player keyboard seek correctly', async () => {
    const seek = page.locator('#seek'); await seek.focus(); await seek.press('Home');
    assert.equal(await page.evaluate(() => window.film.currentTime), 0);
    await seek.press('ArrowRight'); assert.ok(await page.evaluate(() => window.film.currentTime > 0));
    await seek.press('End'); assert.equal(await page.evaluate(() => window.film.currentTime), 60);
    await seek.press('ArrowLeft'); assert.ok(await page.evaluate(() => window.film.currentTime < 60));
    const player = page.locator('#player'); await player.focus(); await player.press('Home');
    await player.press('ArrowRight'); assert.equal(await page.evaluate(() => window.film.currentTime), 5);
    await player.press('ArrowLeft'); assert.equal(await page.evaluate(() => window.film.currentTime), 0);
  });

  await check('play, pause, exact end, replay, and fullscreen controls', async () => {
    await page.evaluate(() => window.film.seek(10)); await page.locator('#play').click();
    await page.waitForFunction(() => window.film.currentTime > 10.1);
    await page.locator('#play').click();
    const paused = await page.evaluate(() => ({ time: window.film.currentTime, playing: window.film.playing }));
    assert.equal(paused.playing, false);
    await page.waitForTimeout(120); assert.equal(await page.evaluate(() => window.film.currentTime), paused.time);
    await page.evaluate(() => { window.film.seek(59.8); window.film.play(); });
    await page.waitForFunction(() => !window.film.playing && window.film.currentTime === 60);
    await page.locator('#replay').click();
    assert.ok(await page.evaluate(() => window.film.playing && window.film.currentTime < 1));
    await page.evaluate(() => window.film.pause());
    if (await page.evaluate(() => document.fullscreenEnabled)) {
      await page.locator('#fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement);
      assert.equal(await page.evaluate(() => document.fullscreenElement.id), 'player');
      await page.locator('#fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement);
    }
  });

  await check('timestamp previews clamp and remain paused', async () => {
    for (const [query, expected] of [['?t=-9', 0], ['?t=83', 60], ['?t=not-a-time', 0], ['?t=33.5', 33.5]]) {
      await open(page, query);
      assert.equal(await page.evaluate(() => window.film.currentTime), expected);
      assert.equal(await page.evaluate(() => window.film.playing), false);
      assert.equal(await page.locator('#start-overlay').isVisible(), false);
    }
  });

  await check('reduced-motion preference and manual toggle', async () => {
    const gentle = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    watch(gentle); await open(gentle, '?t=33');
    assert.equal(await gentle.evaluate(() => window.film.reducedMotion), true);
    assert.equal(await gentle.locator('#motion').getAttribute('aria-pressed'), 'true');
    const first = await inspectFrame(gentle, 33, 'gentle');
    assert.equal(await inspectFrame(gentle, 33.2, 'gentle-still'), first,
      'Reduced-motion scenes should be still between scene changes');
    await gentle.locator('#motion').click();
    assert.equal(await gentle.evaluate(() => window.film.reducedMotion), false);
    assert.equal(await gentle.locator('#motion').getAttribute('aria-pressed'), 'false');
    await gentle.close();
  });

  await check('phone canvas reflows in portrait without overflow; controls remain usable', async () => {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true });
    watch(mobile); await open(mobile, '?t=33');
    const geometry = await mobile.evaluate(() => {
      const canvas = document.getElementById('film-canvas'), rect = canvas.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
        visibleWidth: rect.width, visibleHeight: rect.height, width: canvas.width, height: canvas.height };
    });
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.visibleWidth >= 300 && geometry.visibleHeight > geometry.visibleWidth);
    assert.ok(geometry.height > geometry.width, 'Canvas backing dimensions must reflow too');
    for (const time of [6.5, 9, 15, 21, 26, 33, 38, 41, 46, 58]) await inspectFrame(mobile, time, 'mobile');
    for (const id of ['play', 'replay', 'seek', 'motion']) {
      const control = mobile.locator(`#${id}`); await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `${id} clips horizontally`);
      assert.ok(bounds.height >= 24, `${id} has a very small touch target`);
    }
    await mobile.locator('#play').tap(); assert.equal(await mobile.evaluate(() => window.film.playing), true);
    await mobile.locator('#play').tap(); assert.equal(await mobile.evaluate(() => window.film.playing), false);
    await mobile.close();
  });
  await check('no console errors or failed local resources', async () => {
    assert.deepEqual(browserErrors, []); assert.deepEqual(failedResources, []);
  });
} catch (error) {
  checks.push({ name: 'runner', passed: false, error: error.stack || error.message });
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server.listening) { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
  }
}
const failed = checks.filter(check => !check.passed);
console.log(JSON.stringify({ passed: failed.length === 0, checks, duration: 60, captureCount, captureAssets,
  elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
  frames, screenshots, browserErrors, failedResources,
  note: 'Pixel checks detect blank or duplicate scenes; screenshot review is needed to judge text legibility.' }));
process.exitCode = failed.length ? 1 : 0;
