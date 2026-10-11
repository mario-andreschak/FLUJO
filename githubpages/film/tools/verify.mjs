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
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
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
let browser, base, captureCount = 0, duration, fps, metadata, scenes, clips, representativeTimes;
const started = performance.now();
async function check(name, run) {
  const checkStarted = performance.now();
  console.error(`[verify] start: ${name}`);
  try { const result = await run(); checks.push({ name, passed: result?.skipped ? null : true, ...result }); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); }
  console.error(`[verify] ${checks.at(-1).passed === false ? 'FAIL' : 'done'} (${((performance.now() - checkStarted) / 1000).toFixed(1)}s): ${name}`);
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
  await page.goto(`${base}/film/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.film && window.film.mediaStatus !== 'loading', null, { timeout: 90000 });
  await page.evaluate(() => window.film.ready);
}
async function screenshot(page, name) {
  if (!output) return;
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  screenshots.push(path);
}
async function delayInitialPreparation(page, targetIndex, releaseAfter) {
  await page.addInitScript(({ targetIndex, releaseAfter }) => {
    // A reload clears the injected failure, exercising the actual recovery UI.
    if (releaseAfter === null && sessionStorage.getItem('film-qa-preparation-failed')) return;
    if (releaseAfter === null) sessionStorage.setItem('film-qa-preparation-failed', '1');
    window.filmPreparationQA = { attempts: 0, active: 0, maxActive: 0 };
    const state = window.filmPreparationQA, create = Document.prototype.createElement;
    const time = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const seeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking');
    let videoIndex = 0;
    Document.prototype.createElement = function (tag, ...args) {
      const video = create.call(this, tag, ...args);
      if (tag.toLowerCase() !== 'video') return video;
      const index = videoIndex++; let pending = false, blocked = false, released = false, requested = 0;
      video.addEventListener('seeked', () => { if (pending) { pending = false; state.active--; } });
      Object.defineProperty(video, 'seeking', { get: () => blocked || seeking.get.call(video) });
      Object.defineProperty(video, 'currentTime', {
        get: () => blocked ? requested : time.get.call(video),
        set(value) {
          if (!pending) { pending = true; state.active++; state.maxActive = Math.max(state.maxActive, state.active); }
          if (index === targetIndex && !released && value > 0) {
            blocked = true; requested = value; state.attempts++;
            if (state.attempts === 1 && releaseAfter !== null) setTimeout(() => {
              released = true; blocked = false; time.set.call(video, requested);
            }, releaseAfter);
            return;
          }
          time.set.call(video, value);
        }
      });
      return video;
    };
  }, { targetIndex, releaseAfter });
}
async function assertControlGeometry(page, label, fullscreen = false) {
  const geometry = await page.evaluate(() => {
    const bounds = element => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1,
      controls: bounds(document.querySelector('.controls')), screen: bounds(document.querySelector('.screen')),
      items: [...document.querySelector('.controls').children].map(element => ({ name: element.id || element.className, ...bounds(element) })).filter(item => item.width > 0 && item.height > 0) };
  });
  assert.equal(geometry.overflow, false, `${label} must not overflow horizontally`);
  for (const item of geometry.items) {
    assert.ok(item.left >= -.5 && item.right <= geometry.width + .5, `${label}: ${item.name} must fit horizontally`);
    assert.ok(item.top >= geometry.controls.top - .5 && item.bottom <= geometry.controls.bottom + .5, `${label}: ${item.name} must fit its control area`);
  }
  for (let i = 0; i < geometry.items.length; i++) for (let j = i + 1; j < geometry.items.length; j++) {
    const a = geometry.items[i], b = geometry.items[j];
    const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    assert.equal(overlap, false, `${label}: ${a.name} and ${b.name} must not overlap`);
  }
  if (fullscreen) {
    assert.ok(geometry.screen.top >= -.5 && geometry.controls.bottom <= geometry.height + .5, `${label}: the full player must fit vertically`);
    assert.ok(geometry.screen.bottom <= geometry.controls.top + .5, `${label}: controls must not cover the picture`);
    assert.ok(Math.abs(geometry.screen.width / geometry.screen.height - 1.6) < .02, `${label}: fullscreen must preserve the whole picture`);
  }
}
async function inspectFrame(page, seconds, layout, { seek = true } = {}) {
  if (seek) await page.evaluate(t => window.film.seek(t), seconds);
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
function provenanceRecords(manifest) {
  const clips = (manifest.clips || []).flatMap(clip => {
    if (!Object.hasOwn(clip, 'output')) return [clip];
    assert.ok(clip.output && typeof clip.output === 'object', 'A recording clip needs output metadata');
    // Each approved output inherits the manifest's review and source lineage,
    // and passes through exactly the same validation as a single-output recording.
    return provenanceRecords({ ...manifest, screenshots: [], clips: [], assets: [],
      output: clip.output, edit: { ...manifest.edit, ranges: clip.ranges } });
  });
  const records = [...(manifest.screenshots || []), ...clips, ...(manifest.assets || [])];
  if (!manifest.output) return records;
  // A single-output recording manifest carries review at the top level. Only
  // explicit recording lineage and normal-speed source ranges identify it as footage.
  const { source, output, edit } = manifest;
  assert.equal(manifest.publicUse, 'reviewed', 'The recording output must be explicitly reviewed');
  assert.match(manifest.provenance?.kind || '', /^Genuine screen recording\b/i, 'The output must identify genuine screen-recording provenance');
  assert.ok(typeof source?.fileName === 'string' && source.fileName.length > 0, 'Recording provenance needs a named source');
  assert.match(source?.sha256 || '', /^[a-f0-9]{64}$/i, 'Recording provenance needs a source SHA-256');
  assert.ok(Number.isFinite(source.durationSeconds) && source.durationSeconds > 0);
  assert.ok(typeof output.path === 'string' && output.path.length > 0, 'Recording output needs a file path');
  assert.ok(Number.isFinite(output.durationSeconds) && output.durationSeconds > 0);
  for (const dimension of ['width', 'height']) {
    assert.ok(Number.isFinite(source[dimension]) && source[dimension] > 0);
    assert.equal(output[dimension], source[dimension], 'A full-frame recording excerpt must preserve source dimensions');
  }
  assert.ok(Array.isArray(edit?.ranges) && edit.ranges.length > 0, 'Recording excerpts need explicit source ranges');
  let outputEnd = 0, sourceEnd = 0;
  for (const range of edit.ranges) {
    assert.ok([range.sourceStart, range.sourceEnd, range.outputStart, range.outputEnd].every(Number.isFinite));
    assert.ok(range.sourceStart >= sourceEnd && range.sourceEnd > range.sourceStart && range.sourceEnd <= source.durationSeconds,
      'Recording excerpts must retain source order and stay within the recorded source');
    assert.equal(range.outputStart, outputEnd, 'Recording output ranges must be contiguous');
    assert.ok(Math.abs((range.outputEnd - range.outputStart) - (range.sourceEnd - range.sourceStart)) < 1e-6,
      'Recording source ranges must retain normal speed');
    outputEnd = range.outputEnd; sourceEnd = range.sourceEnd;
  }
  assert.ok(Math.abs(outputEnd - output.durationSeconds) < 1e-6, 'Recording ranges must cover the complete output');
  records.push({ ...output, file: output.path, publicUse: manifest.publicUse, kind: 'screen-recording-excerpt' });
  return records;
}

try {
  if (output) await mkdir(output, { recursive: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
  watch(page); await open(page);
  captureCount = await page.evaluate(() => window.film.captureCount ?? 0);
  ({ duration, fps, metadata, scenes } = await page.evaluate(() => ({ duration: window.film.duration,
    fps: window.film.fps, metadata: window.film.metadata, scenes: window.film.scenes })));
  clips = await page.evaluate(async () => (await import('./captures.js')).CLIPS);
  representativeTimes = [...new Set([0, ...scenes.flatMap(scene => scene.reviewTimes || [(scene.start + scene.end) / 2]),
    ...(metadata.reviewTimes || []), ...Object.values(clips).map(clip => (clip.start + clip.end) / 2), duration])];

  await check('capture hashes match provenance; final publication requires finalized review', async () => {
    const { CAPTURES, CLIPS } = await page.evaluate(async () => {
      const { CAPTURES, CLIPS } = await import('./captures.js'); return { CAPTURES, CLIPS };
    });
    const entries = [...Object.values(CAPTURES).map(entry => ({ ...entry, isClip: false })),
      ...Object.values(CLIPS).map(entry => ({ ...entry, isClip: true }))];
    if (entries.length === 0 && metadata.stage === 'prototype') return { skipped: 'No recorded source assets are connected to this prototype yet.' };
    const seen = new Set();
    for (const entry of entries) for (const source of [entry.src, entry.mobileSrc].filter(Boolean)) {
      const identity = `${source}:${entry.provenance || 'default'}:${entry.isClip}`;
      if (seen.has(identity)) continue; seen.add(identity);
      const absolute = resolve(root, 'film', source);
      assert.ok(absolute.startsWith(root + sep), 'Capture source must stay inside the published site');
      const file = 'githubpages/' + absolute.slice(root.length + 1).split(sep).join('/');
      const manifestPath = entry.provenance ? resolve(root, 'film', entry.provenance) : resolve(root, '../docs/journeys/evidence/capture-manifest.json');
      assert.ok(manifestPath.startsWith(resolve(root, '..') + sep), 'Provenance must stay inside the repository');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const isFinal = metadata.stage === 'final';
      if (isFinal) assert.equal(manifest.status, 'final', 'Final capture provenance must be finalized');
      else assert.ok(['prototype', 'final'].includes(manifest.status), 'Prototype provenance must be explicitly labeled');
      const records = provenanceRecords(manifest);
      const record = records.find(item => item.file === file || resolve(dirname(manifestPath), item.file) === absolute);
      assert.ok(record, `No provenance record for ${file}`);
      assert.equal(record.publicUse, 'reviewed', `${file} is not reviewed for publication`);
      assert.match(record.sha256 || '', /^[a-f0-9]{64}$/i, `${file} needs a SHA-256 provenance hash`);
      if (isFinal && entry.isClip) assert.ok(['screen-recording', 'screen-recording-excerpt'].includes(record.kind),
        `${file} must be identified as genuine screen-recorded footage`);
      const bytes = await readFile(absolute);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256, record.sha256, `${file} changed since its provenance review`);
      captureAssets.push({ file, sha256, bytes: bytes.length, status: manifest.status, publicUse: record.publicUse });
    }
  });

  await check('contiguous renderer timeline; dynamic duration; no autoplay; accessible controls', async () => {
    const state = await page.evaluate(() => ({ duration: window.film.duration,
      time: window.film.currentTime, playing: window.film.playing, scenes: window.film.scenes }));
    assert.ok(Number.isFinite(duration) && duration > 0); assert.ok(Number.isFinite(fps) && fps > 0);
    assert.ok(Math.abs(duration * fps - Math.round(duration * fps)) < 1e-6, 'Duration must contain a whole number of timeline frames');
    assert.equal(state.time, 0); assert.equal(state.playing, false);
    assert.ok(['prototype', 'final'].includes(metadata.stage), 'Film stage must be explicit');
    assert.ok(metadata.title?.length > 0); assert.match(metadata.exportFilename, /^[-a-zA-Z0-9_.]+\.mp4$/);
    if (metadata.stage === 'prototype') assert.equal(metadata.exportReady, false, 'A prototype must not enable final download or export');
    assert.equal(typeof metadata.downloadReady, 'boolean', 'Download availability must be explicit');
    if (metadata.downloadReady) {
      assert.equal(metadata.stage, 'final', 'Only a final film can offer a download');
      assert.equal(metadata.exportReady, true, 'A downloadable film must have passed the export gate');
    }
    assert.ok(state.scenes.length > 0); assert.equal(state.scenes[0].start, 0); assert.equal(state.scenes.at(-1).end, duration);
    for (let i = 0; i < state.scenes.length; i++) {
      const scene = state.scenes[i];
      assert.ok(Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end > scene.start);
      assert.ok(scene.title?.length > 0 && scene.text?.length > 0, 'Every chapter needs a title and transcript');
      if (i > 0) assert.equal(scene.start, state.scenes[i - 1].end);
    }
    for (const time of representativeTimes) assert.ok(Number.isFinite(time) && time >= 0 && time <= duration);
    const range = page.locator('#seek');
    assert.equal(await range.getAttribute('type'), 'range');
    assert.equal(await range.getAttribute('max'), String(duration));
    const durationLabel = `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
    assert.ok((await page.locator('#time').textContent()).endsWith(`/ ${durationLabel}`));
    assert.ok((await range.getAttribute('aria-valuetext')).endsWith(`of ${durationLabel}`));
    for (const id of ['play', 'replay', 'motion', 'fullscreen']) {
      const info = await page.locator(`#${id}`).evaluate(el => ({ tag: el.tagName,
        name: el.getAttribute('aria-label') || el.textContent.trim() }));
      assert.equal(info.tag, 'BUTTON'); assert.ok(info.name.length > 0);
    }
    assert.equal(await page.locator('#scene-status').getAttribute('aria-live'), 'polite');
    assert.equal(await page.locator('audio, video').count(), 0, 'Film must remain silent');
    for (const download of await page.locator('.download-link, [data-film-download]').all()) {
      if (metadata.exportReady === true && metadata.downloadReady === true) {
        assert.equal(await download.isVisible(), true);
        assert.equal(await download.getAttribute('href'), metadata.exportFilename);
      }
      else { assert.equal(await download.isVisible(), false); assert.equal(await download.getAttribute('href'), null); }
    }
  });

  await check('representative desktop scenes render distinctly and deterministically', async () => {
    const times = representativeTimes;
    const signatures = [];
    for (const time of times) signatures.push(await inspectFrame(page, time, 'desktop'));
    assert.ok(new Set(signatures).size >= Math.min(2, scenes.length), 'Distinct chapters should not all render the same frame');
    const repeatIndex = Math.floor(times.length / 2);
    assert.equal(await inspectFrame(page, times[repeatIndex], 'desktop-repeat'), signatures[repeatIndex]);
  });

  await check('API seek clamps negative, overshoot and nonfinite values', async () => {
    for (const [input, expected] of [[-10, 0], [duration + 15, duration], [Infinity, 0], [NaN, 0], [duration / 3, duration / 3]]) {
      const time = await page.evaluate(async value => { await window.film.seek(value); return window.film.currentTime; }, input);
      assert.equal(time, expected);
    }
  });

  await check('native range keyboard and focused player keyboard seek correctly', async () => {
    const seek = page.locator('#seek'); await seek.focus(); await seek.press('Home');
    assert.equal(await page.evaluate(() => window.film.currentTime), 0);
    await seek.press('ArrowRight'); assert.ok(await page.evaluate(() => window.film.currentTime > 0));
    await seek.press('End'); assert.equal(await page.evaluate(() => window.film.currentTime), duration);
    await seek.press('ArrowLeft'); assert.ok(await page.evaluate(() => window.film.currentTime < window.film.duration));
    const player = page.locator('#player'); await player.focus(); await player.press('Home');
    await player.press('ArrowRight'); assert.equal(await page.evaluate(() => window.film.currentTime), Math.min(5, duration));
    await player.press('ArrowLeft'); assert.equal(await page.evaluate(() => window.film.currentTime), 0);
  });

  await check('chapter navigation jumps to exact timeline positions', async () => {
    const nav = page.locator('#chapter-nav');
    if (await nav.count()) {
      const buttons = nav.locator('button[data-chapter]'); assert.equal(await buttons.count(), scenes.length);
      for (const index of [...new Set([0, Math.floor(scenes.length / 2), scenes.length - 1])]) {
        await buttons.nth(index).click();
        await page.waitForFunction(t => window.film.currentTime === t && !window.film.playing, scenes[index].start);
        await page.waitForFunction(i => document.querySelector(`#chapter-nav [data-chapter="${i}"]`)?.getAttribute('aria-current') === 'true', index);
        assert.equal(await buttons.nth(index).getAttribute('aria-current'), 'true');
      }
    }
    assert.equal(await page.locator('#chapters li').count(), scenes.length);
  });

  await check('play, pause, exact end, replay, and fullscreen controls', async () => {
    const playTime = duration / 3;
    await page.evaluate(t => window.film.seek(t), playTime); await page.locator('#play').click();
    await page.waitForFunction(t => window.film.currentTime > t + .1, playTime);
    await page.locator('#play').click();
    const paused = await page.evaluate(() => ({ time: window.film.currentTime, playing: window.film.playing }));
    assert.equal(paused.playing, false);
    await page.waitForTimeout(120); assert.equal(await page.evaluate(() => window.film.currentTime), paused.time);
    await page.evaluate(async () => { await window.film.seek(window.film.duration - .2); window.film.play(); });
    await page.waitForFunction(() => !window.film.playing && window.film.currentTime === window.film.duration);
    assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Replay film');
    await page.locator('#replay').click();
    await page.waitForFunction(() => window.film.playing && window.film.currentTime < 1);
    await page.evaluate(() => window.film.pause());
    if (await page.evaluate(() => document.fullscreenEnabled)) {
      await page.locator('#fullscreen').click(); await page.waitForFunction(() => !!document.fullscreenElement);
      assert.equal(await page.evaluate(() => document.fullscreenElement.id), 'player');
      await page.locator('#fullscreen').click(); await page.waitForFunction(() => !document.fullscreenElement);
    }
  });

  await check('hiding the document pauses timeline and media', async () => {
    const state = await page.evaluate(async () => {
      await window.film.seek(window.film.duration / 3); window.film.play();
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      try {
        document.dispatchEvent(new Event('visibilitychange'));
        return { playing: window.film.playing, media: window.film.mediaState };
      } finally { Reflect.deleteProperty(document, 'hidden'); }
    });
    assert.equal(state.playing, false); assert.ok(state.media.every(clip => clip.paused));
  });

  await check('1×, 2× and 5× keep timeline and footage synchronized through speed changes, seeks and replay', async () => {
    const control = page.locator('#playback-speed');
    assert.equal(await control.evaluate(element => element.tagName), 'SELECT');
    assert.ok((await control.evaluate(element => element.getAttribute('aria-label') || [...element.labels || []].map(label => label.textContent).join(' '))).trim().length >= 5, 'Playback speed needs an accessible name');
    assert.deepEqual(await control.locator('option').evaluateAll(options => options.map(option => option.value)), ['1', '2', '5']);
    assert.equal(await control.inputValue(), '1');
    assert.equal(await page.evaluate(() => window.film.playbackRate), 1, 'Every fresh player and export starts at 1×');
    const [key, clip] = Object.entries(clips).find(([, entry]) => entry.sourceEnd - (entry.sourceStart ?? 0) >= 4 && entry.holdLead >= 1 && entry.holdTail >= 1) || [];
    assert.ok(clip, 'Speed acceptance needs an excerpt with recorded action and explicit holds');
    const actionStart = clip.start + clip.holdLead, time = actionStart + .4;
    const sourceAt = time => Math.min(clip.sourceEnd, (clip.sourceStart ?? 0) + Math.max(0, time - actionStart) * (clip.rate ?? 1));
    let fixedFrame;
    try {
      for (const rate of [1, 2, 5]) {
        await control.selectOption(String(rate));
        assert.equal(await page.evaluate(() => window.film.playbackRate), rate);
        const signature = await inspectFrame(page, time, `speed-${rate}-seek`);
        if (fixedFrame) assert.equal(signature, fixedFrame, 'Playback speed must not change an explicitly sought frame');
        fixedFrame = signature;
        const measured = await page.evaluate(async key => {
          const start = window.film.currentTime, wallStart = performance.now();
          window.film.play();
          await new Promise(resolve => setTimeout(resolve, 260));
          window.film.pause();
          return { advance: window.film.currentTime - start, wallSeconds: (performance.now() - wallStart) / 1000,
            time: window.film.currentTime, media: window.film.mediaState.find(clip => clip.key === key) };
        }, key);
        assert.ok(Math.abs(measured.advance - measured.wallSeconds * rate) < .08, `${rate}× timeline clock must match elapsed wall time`);
        assert.equal(measured.media.playbackRate, (clip.rate ?? 1) * rate);
        assert.ok(Math.abs(measured.media.time - sourceAt(measured.time)) < .35, `${rate}× recorded footage must track the timeline`);
        assert.equal(measured.media.paused, true);
        for (const [kind, position] of [['lead', clip.start + .1], ['tail', clip.end - .8]]) {
          await page.evaluate(time => window.film.seek(time), position);
          const held = await page.evaluate(async key => {
            const before = window.film.mediaState.find(clip => clip.key === key);
            window.film.play(); await new Promise(resolve => setTimeout(resolve, 70)); window.film.pause();
            return { before, after: window.film.mediaState.find(clip => clip.key === key) };
          }, key);
          assert.equal(held.after.hold, kind); assert.equal(held.after.paused, true);
          assert.ok(Math.abs(held.after.time - held.before.time) < .004, `${rate}× must retain its ${kind} source hold`);
        }
        await page.evaluate(async time => { await window.film.seek(time); window.film.play(); }, time);
        const changedRate = rate === 5 ? 2 : 5;
        await page.evaluate(async ([time, rate]) => { const pending = window.film.seek(time); window.film.setPlaybackRate(rate); await pending; }, [time + .2, changedRate]);
        assert.equal(await page.evaluate(() => window.film.playing), true, 'Speed changes during a seek must retain resume intent');
        assert.equal(await page.evaluate(() => window.film.playbackRate), changedRate);
        await page.evaluate(() => window.film.pause());
        await control.selectOption(String(rate));
        await page.evaluate(async () => { await window.film.seek(window.film.duration - .15); window.film.play(); });
        await page.waitForFunction(() => !window.film.playing && window.film.currentTime === window.film.duration);
        assert.equal(await page.evaluate(() => window.film.playbackRate), rate);
        await page.locator('#replay').click(); await page.waitForFunction(() => window.film.playing && window.film.currentTime < 2);
        assert.equal(await page.evaluate(() => window.film.playbackRate), rate, 'Replay must retain the chosen speed');
        await page.evaluate(() => window.film.pause());
      }
      await page.evaluate(async time => { window.film.setPlaybackRate(1); await window.film.seek(time); }, time);
      const switched = await page.evaluate(async () => {
        const wait = () => new Promise(resolve => setTimeout(resolve, 100));
        const start = window.film.currentTime, wallStart = performance.now();
        window.film.play(); await wait();
        const firstSwitch = performance.now(); window.film.setPlaybackRate(2); await wait();
        const secondSwitch = performance.now(); window.film.setPlaybackRate(5); await wait();
        const thirdSwitch = performance.now(); window.film.setPlaybackRate(1); await wait();
        const end = performance.now(); window.film.pause();
        return { actual: window.film.currentTime - start,
          expected: ((firstSwitch - wallStart) + (secondSwitch - firstSwitch) * 2 + (thirdSwitch - secondSwitch) * 5 + (end - thirdSwitch)) / 1000 };
      });
      assert.ok(Math.abs(switched.actual - switched.expected) < .08, 'Changing speed during playback must preserve elapsed time without jumps');
      const paused = await page.evaluate(() => { const before = window.film.currentTime; window.film.setPlaybackRate(5); return { before, after: window.film.currentTime, playing: window.film.playing }; });
      assert.equal(paused.after, paused.before); assert.equal(paused.playing, false);
      assert.equal(await page.evaluate(() => { try { window.film.setPlaybackRate(3); return false; } catch { return window.film.playbackRate === 5; } }), true);
      await page.locator('#motion').click(); await page.evaluate(time => window.film.seek(time), time);
      await page.evaluate(() => window.film.play()); await page.waitForTimeout(80); await page.evaluate(() => window.film.pause());
      assert.ok((await page.evaluate(() => window.film.mediaState)).every(clip => clip.paused), 'Gentle-motion sources stay held at 5×');
      await page.locator('#motion').click(); await page.evaluate(time => window.film.seek(time), time);
    } finally {
      await page.evaluate(async () => {
        window.film.pause(); window.film.setPlaybackRate(1);
        if (window.film.reducedMotion) document.getElementById('motion').click();
        await window.film.seek(window.film.currentTime);
      });
    }
  });

  await check('timestamp previews clamp and remain paused', async () => {
    for (const [query, expected] of [['?t=-9', 0], [`?t=${duration + 23}`, duration], ['?t=not-a-time', 0], [`?t=${duration / 3}`, duration / 3]]) {
      await open(page, query);
      assert.equal(await page.evaluate(() => window.film.currentTime), expected);
      assert.equal(await page.evaluate(() => window.film.playing), false);
      assert.equal(await page.locator('#start-overlay').isVisible(), false);
    }
  });

  await check('genuine clips seek deterministically, stay silent and pause with the timeline', async () => {
    if (metadata.stage === 'final') assert.ok(Object.keys(clips).length > 0, 'A final walkthrough must include genuine recorded journey footage');
    if (Object.keys(clips).length === 0) return { skipped: 'No recorded clips are connected; source seeking and hold behavior have not been exercised.' };
    for (const [key, clip] of Object.entries(clips)) {
      console.error(`[verify] clip: ${key}`);
      assert.ok(Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.start >= 0 && clip.end <= duration && clip.end > clip.start, `${key} has invalid timeline bounds`);
      assert.ok(Number.isFinite(clip.rate ?? 1) && (clip.rate ?? 1) > 0, `${key} has an invalid playback rate`);
      assert.ok(Number.isFinite(clip.sourceStart ?? 0) && (clip.sourceStart ?? 0) >= 0, `${key} has an invalid source offset`);
      const rate = clip.rate ?? 1, sourceStart = clip.sourceStart ?? 0, holdLead = clip.holdLead ?? 0, holdTail = clip.holdTail ?? 0;
      assert.ok(Number.isFinite(holdLead) && holdLead >= 0 && Number.isFinite(holdTail) && holdTail >= 0, `${key} has invalid hold durations`);
      const sourceEnd = clip.sourceEnd ?? sourceStart + (clip.end - clip.start - holdLead - holdTail) * rate;
      assert.ok(Number.isFinite(sourceEnd) && sourceEnd > sourceStart, `${key} needs a nonempty recorded interval`);
      assert.ok(Math.abs(holdLead + (sourceEnd - sourceStart) / rate + holdTail - (clip.end - clip.start)) < 1e-6, `${key} source interval and holds do not match timeline length`);
      const actionStart = clip.start + holdLead, actionEnd = actionStart + (sourceEnd - sourceStart) / rate;
      const offset = Math.min(.4, (actionEnd - actionStart) / 4), time = actionStart + offset;
      await page.evaluate(t => window.film.seek(t), time);
      let state = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
      const positionAt = t => Math.min(state.duration - .05, sourceEnd, sourceStart + Math.max(0, t - actionStart) * rate);
      const expected = positionAt(time);
      assert.ok(Math.abs(state.time - expected) < .07, `${key} seek missed the recorded frame`);
      assert.equal(state.paused, true); assert.equal(state.muted, true); assert.ok(state.readyState >= 2);
      assert.equal(state.bufferedSource, true, 'Recorded clips must seek on previews without HTTP Range support');
      await page.evaluate(() => window.film.play());
      const advance = Math.min(.3, (actionEnd - time) / 2);
      await page.waitForFunction(t => window.film.currentTime > t, time + advance);
      await page.evaluate(() => window.film.pause());
      state = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
      if (expected + advance * rate < state.duration - .1)
        assert.ok(state.time > expected + advance * rate / 3, `${key} did not advance during playback`);
      assert.equal(state.paused, true);
      const latest = time + Math.min(.2, (actionEnd - time) / 4);
      await page.evaluate(async ([first, last]) => { await Promise.all([window.film.seek(first), window.film.seek(last)]); }, [time, latest]);
      assert.ok(Math.abs(await page.evaluate(() => window.film.currentTime) - latest) < .001);
      state = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
      assert.ok(Math.abs(state.time - positionAt(latest)) < .07, `${key} concurrent seek ended on the wrong source frame`);
      const concurrentFrame = await inspectFrame(page, latest, `${key}-concurrent`, { seek: false });
      assert.equal(await inspectFrame(page, latest, `${key}-sequential`), concurrentFrame, `${key} concurrent and sequential seeks must draw the same frame`);
      assert.equal(await page.evaluate(() => window.film.mediaError), '');
      for (const [kind, holdStart, holdEnd] of [['lead', clip.start, actionStart], ['tail', actionEnd, clip.end]]) {
        if (holdEnd <= holdStart) continue;
        const holdTime = (holdStart + holdEnd) / 2;
        await page.evaluate(t => window.film.seek(t), holdTime);
        state = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
        assert.equal(state.hold, kind, `${key} ${kind} hold must be explicit`);
        assert.equal(state.paused, true); assert.ok(Math.abs(state.time - positionAt(holdTime)) < .07);
        if (holdEnd - holdTime > .2) {
          const heldPosition = state.time;
          await page.evaluate(() => window.film.play());
          await page.waitForFunction(t => window.film.currentTime > t, holdTime + .1);
          await page.evaluate(() => window.film.pause());
          state = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
          assert.equal(state.paused, true); assert.ok(Math.abs(state.time - heldPosition) < .004, `${key} advanced during its ${kind} hold`);
        }
      }
      await page.evaluate(t => window.film.seek(t), Math.max(0, clip.start - .2));
      await page.evaluate(() => window.film.play());
      await page.waitForFunction(t => window.film.currentTime >= t, clip.start);
      const boundary = await page.evaluate(k => window.film.mediaState.find(item => item.key === k), key);
      assert.ok(boundary.readyState >= 2 && !boundary.seeking, `${key} was not prepared at the scene boundary`);
      assert.ok(Math.abs(boundary.time - (clip.sourceStart || 0)) < .3, `${key} briefly showed the wrong source interval`);
      await page.evaluate(() => window.film.pause());
    }
    // A rapid chapter/scrubber burst may cross source files while Play is
    // pressed. The last request must own both the frame and resumed clock.
    const recorded = Object.entries(clips);
    const [lastKey, lastClip] = recorded.at(-1);
    const lastTime = lastClip.start + Math.min(.1, (lastClip.end - lastClip.start) / 4);
    const burst = [recorded[0][1].start, lastTime, recorded[Math.floor(recorded.length / 2)][1].start, lastTime];
    await page.evaluate(async times => {
      const requests = times.map(time => window.film.seek(time));
      window.film.play();
      await Promise.all(requests);
    }, burst);
    assert.equal(await page.evaluate(() => window.film.playing), true, 'Play during a seek burst must resume the latest request');
    await page.waitForFunction(time => window.film.currentTime > time + .1, lastTime);
    await page.evaluate(() => window.film.pause());
    const resumed = await page.evaluate(key => ({ time: window.film.currentTime, media: window.film.mediaState.find(clip => clip.key === key) }), lastKey);
    assert.ok(resumed.time >= lastTime && resumed.time < lastClip.end, 'The resumed clock must belong to the last requested shot');
    assert.equal(resumed.media.paused, true); assert.equal(resumed.media.seeking, false);
    const resumedFrame = await inspectFrame(page, resumed.time, 'rapid-seek-resume', { seek: false });
    assert.equal(await inspectFrame(page, resumed.time, 'rapid-seek-settled'), resumedFrame, 'Rapid seek/play must settle on the same deterministic frame');
  });

  await check('provider pointer travels during the lead hold without advancing recorded video', async () => {
    const shot = await page.evaluate(async () => (await import('./renderer.js')).SHOTS.find(shot => shot.id === 'choose-provider'));
    assert.ok(shot, 'The provider-selection regression needs its recorded shot');
    const signatures = [];
    for (const offset of [4.3, 4.85]) {
      signatures.push(await inspectFrame(page, shot.start + offset, `provider-pointer-${offset}`));
      const media = await page.evaluate(() => window.film.mediaState.find(clip => clip.key === 'choose-provider'));
      assert.ok(Math.abs(media.time - 5.2) < .004, 'Pointer travel must preserve the first recorded frame during the lead hold');
      assert.equal(media.hold, 'lead'); assert.equal(media.paused, true); assert.equal(media.seeking, false);
    }
    assert.notEqual(signatures[0], signatures[1], 'The pointer must approach its target while the settled camera and recorded frame are held');
    const click = shot.events.find(event => event.type === 'click');
    const mappedClick = shot.start + shot.holdLead + click.at - shot.sourceStart;
    assert.ok(Math.abs(mappedClick - (shot.start + 5.173)) < 1e-9, 'The click must retain its recorded presentation timestamp');
    await page.evaluate(time => window.film.seek(time), mappedClick);
    const media = await page.evaluate(() => window.film.mediaState.find(clip => clip.key === 'choose-provider'));
    assert.ok(Math.abs(media.time - click.at) < .004, 'At the click timestamp, video must match the recorded click source time');
    assert.equal(media.hold, null); assert.equal(media.paused, true);
  });

  await check('final frame matches in end preview, direct seek, and natural playback end', async () => {
    const finalClips = Object.entries(clips).filter(([, clip]) => clip.end === duration);
    const assertFinalSources = async () => {
      const state = await page.evaluate(() => ({ playing: window.film.playing, time: window.film.currentTime, media: window.film.mediaState }));
      assert.equal(state.playing, false); assert.equal(state.time, duration);
      for (const [key, clip] of finalClips) {
        const media = state.media.find(item => item.key === key);
        const sourceEnd = clip.sourceEnd ?? (clip.sourceStart ?? 0) + (clip.end - clip.start - (clip.holdLead ?? 0) - (clip.holdTail ?? 0)) * (clip.rate ?? 1);
        assert.ok(Math.abs(media.time - Math.min(media.duration - .05, sourceEnd)) < .004, `${key} must display its intended final source frame`);
        assert.equal(media.paused, true); assert.equal(media.seeking, false);
      }
    };
    await open(page, `?t=${duration}`);
    await assertFinalSources();
    const previewFrame = await inspectFrame(page, duration, 'exact-end-preview', { seek: false });
    await page.evaluate(async () => { await window.film.seek(0); await window.film.seek(window.film.duration); });
    await assertFinalSources();
    assert.equal(await inspectFrame(page, duration, 'exact-end-seek', { seek: false }), previewFrame);
    await page.evaluate(async () => { await window.film.seek(Math.max(0, window.film.duration - .2)); window.film.play(); });
    await page.waitForFunction(() => !window.film.playing && window.film.currentTime === window.film.duration && window.film.mediaState.every(clip => !clip.seeking));
    await assertFinalSources();
    assert.equal(await inspectFrame(page, duration, 'exact-end-playback', { seek: false }), previewFrame);
  });

  await check('delayed media shows a calm loading state and enables playback only when ready', async () => {
    const firstClip = Object.values(clips)[0];
    if (!firstClip) return { skipped: 'No recorded clip is connected for delayed-media acceptance.' };
    const delayed = await browser.newPage({ viewport: { width: 696, height: 900 }, deviceScaleFactor: 1 });
    watch(delayed);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await delayed.addInitScript(() => {
        window.drawnFilmText = [];
        const fillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
          window.drawnFilmText.push(String(text)); return fillText.call(this, text, ...args);
        };
      });
      await delayed.route(new URL(firstClip.src, `${base}/film/`).href, async route => { await gate; await route.continue(); });
      await delayed.goto(`${base}/film/`, { waitUntil: 'domcontentloaded' });
      await delayed.waitForFunction(() => window.film?.mediaStatus === 'loading' && window.drawnFilmText.includes('Loading walkthrough'));
      assert.equal(await delayed.locator('#player').getAttribute('aria-busy'), 'true');
      assert.equal(await delayed.locator('#play').isDisabled(), true);
      assert.equal(await delayed.locator('#replay').isDisabled(), true);
      assert.equal(await delayed.locator('#start-overlay').isVisible(), false);
      const loadingFrame = await inspectFrame(delayed, 0, 'delayed-loading', { seek: false });
      await delayed.locator('#player').focus(); await delayed.locator('#player').press('k');
      assert.equal(await delayed.evaluate(() => window.film.playing), false);
      assert.equal(await delayed.evaluate(() => window.film.mediaError), '');
      assert.equal(await delayed.evaluate(() => window.drawnFilmText.some(text => /not available|could not|failed/i.test(text))), false);
      release(); await delayed.evaluate(() => window.film.ready);
      assert.equal(await delayed.evaluate(() => window.film.mediaStatus), 'ready');
      assert.equal(await delayed.locator('#player').getAttribute('aria-busy'), 'false');
      assert.equal(await delayed.locator('#play').isDisabled(), false);
      assert.equal(await delayed.locator('#replay').isDisabled(), false);
      assert.equal(await delayed.evaluate(() => window.film.playing), false, 'A key pressed while loading must not queue autoplay');
      assert.equal(await delayed.evaluate(() => window.drawnFilmText.some(text => /not available|could not|failed/i.test(text))), false);
      assert.notEqual(await inspectFrame(delayed, 0, 'delayed-ready', { seek: false }), loadingFrame);
      await delayed.locator('#play').click();
      await delayed.waitForFunction(() => window.film.playing && window.film.currentTime > .1);
      await delayed.evaluate(() => window.film.pause());
    } finally { release(); await delayed.close(); }
  });

  await check('failed asset load reports an error while chapter navigation remains available', async () => {
    const recovery = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const runtimeErrors = []; recovery.on('pageerror', error => runtimeErrors.push(error.message));
    try {
      await recovery.route('**/film/brand.svg', route => route.fulfill({ status: 404, body: '' }));
      await recovery.goto(`${base}/film/`, { waitUntil: 'domcontentloaded' });
      await recovery.waitForFunction(() => window.film && window.film.mediaStatus !== 'loading', null, { timeout: 90000 });
      const state = await recovery.evaluate(async () => {
        const rejected = await window.film.ready.then(() => false, () => true);
        await window.film.seek(window.film.duration / 2);
        return { rejected, time: window.film.currentTime, error: window.film.mediaError,
          label: document.getElementById('film-canvas').getAttribute('aria-label'),
          display: document.getElementById('time').textContent };
      });
      assert.equal(state.rejected, true); assert.equal(state.time, duration / 2); assert.ok(state.error);
      assert.equal(await recovery.evaluate(() => window.film.mediaStatus), 'error');
      assert.equal(await recovery.locator('#media-error-panel').isVisible(), true);
      assert.equal(await recovery.locator('#retry-media').isEnabled(), true);
      assert.ok((await recovery.locator('#retry-media').boundingBox()).height >= 44);
      assert.equal(await recovery.locator('#player').getAttribute('aria-busy'), 'false');
      assert.equal(await recovery.locator('#play').isDisabled(), true);
      const scene = scenes.find(scene => duration / 2 >= scene.start && duration / 2 < scene.end);
      assert.ok(state.label.startsWith(scene.title));
      const label = `${Math.floor(duration / 2 / 60)}:${String(Math.floor(duration / 2 % 60)).padStart(2, '0')}`;
      assert.ok(state.display.startsWith(`${label} / `)); assert.deepEqual(runtimeErrors, []);
      await recovery.unroute('**/film/brand.svg');
      await recovery.locator('#retry-media').click();
      await recovery.waitForFunction(() => window.film?.mediaStatus === 'ready', null, { timeout: 90000 });
      await recovery.evaluate(() => window.film.ready);
      assert.equal(await recovery.locator('#media-error-panel').isVisible(), false);
      assert.equal(await recovery.locator('#play').isEnabled(), true);
    } finally { await recovery.close(); }
  });

  await check('slow initial seeking retries once with at most four preparations and preserves every source position', async () => {
    const delayed = await browser.newPage({ viewport: { width: 711, height: 900 } });
    watch(delayed);
    const target = Object.values(clips).findIndex(clip => (clip.sourceStart ?? 0) > 0);
    assert.ok(target >= 0);
    try {
      await delayInitialPreparation(delayed, target, 17000);
      await delayed.goto(`${base}/film/`, { waitUntil: 'domcontentloaded' });
      await delayed.waitForFunction(() => window.filmPreparationQA?.attempts === 1, null, { timeout: 90000 });
      assert.equal(await delayed.evaluate(() => window.film.mediaStatus), 'loading');
      await delayed.evaluate(() => { window.loadingSeekQA = window.film.seek(0); window.film.setPlaybackRate(2); window.film.play(); });
      await delayed.waitForFunction(() => window.filmPreparationQA.attempts === 2, null, { timeout: 30000 });
      assert.equal(await delayed.evaluate(() => window.film.mediaStatus), 'loading');
      assert.equal(await delayed.evaluate(() => window.film.mediaError), '');
      assert.equal(await delayed.locator('#media-error-panel').isVisible(), false);
      assert.equal(await delayed.locator('#play').isDisabled(), true);
      await delayed.waitForFunction(() => window.film.mediaStatus !== 'loading', null, { timeout: 30000 });
      await delayed.evaluate(async () => { await window.film.ready; await window.loadingSeekQA; });
      const state = await delayed.evaluate(() => ({ status: window.film.mediaStatus, error: window.film.mediaError, playing: window.film.playing,
        preparation: window.filmPreparationQA, media: window.film.mediaState }));
      assert.equal(state.status, 'ready'); assert.equal(state.error, ''); assert.equal(state.playing, false);
      assert.equal(state.preparation.attempts, 2); assert.ok(state.preparation.maxActive <= 4);
      assert.equal(state.media.length, Object.keys(clips).length);
      for (const media of state.media) {
        assert.ok(Math.abs(media.time - (clips[media.key].sourceStart ?? 0)) < .004, `${media.key} must finish preparing its own source start`);
        assert.equal(media.seeking, false); assert.equal(media.paused, true); assert.ok(media.readyState >= 2);
      }
      assert.equal(await delayed.locator('#play').isEnabled(), true);
    } finally { await delayed.close(); }
  });

  await check('exhausted preparation retries stay visibly failed until the reload control recovers', async () => {
    const recovery = await browser.newPage({ viewport: { width: 320, height: 844 } });
    watch(recovery);
    const target = Object.values(clips).findIndex(clip => (clip.sourceStart ?? 0) > 0);
    try {
      await delayInitialPreparation(recovery, target, null);
      await recovery.goto(`${base}/film/`, { waitUntil: 'domcontentloaded' });
      await recovery.waitForFunction(() => window.film?.mediaStatus === 'error', null, { timeout: 90000 });
      assert.equal(await recovery.evaluate(() => window.film.ready.then(() => false, () => true)), true);
      assert.equal(await recovery.evaluate(() => window.filmPreparationQA.attempts), 2);
      assert.ok(await recovery.evaluate(() => window.filmPreparationQA.maxActive <= 4));
      assert.match(await recovery.evaluate(() => window.film.mediaError), /seek timed out/);
      assert.equal(await recovery.locator('#media-error-panel').isVisible(), true);
      assert.equal(await recovery.locator('#play').isDisabled(), true);
      assert.equal(await recovery.locator('#replay').isDisabled(), true);
      assert.equal(await recovery.locator('#retry-media').isEnabled(), true);
      const button = await recovery.locator('#retry-media').boundingBox();
      assert.ok(button.height >= 44 && button.x >= 0 && button.x + button.width <= 320);
      await recovery.locator('#retry-media').click();
      await recovery.waitForFunction(() => window.film?.mediaStatus === 'ready', null, { timeout: 90000 });
      await recovery.evaluate(() => window.film.ready);
      assert.equal(await recovery.evaluate(() => window.film.mediaError), '');
      assert.equal(await recovery.locator('#media-error-panel').isVisible(), false);
      assert.equal(await recovery.locator('#play').isEnabled(), true);
      assert.equal(await recovery.evaluate(() => window.film.clipCount), Object.keys(clips).length);
    } finally { await recovery.close(); }
  });

  await check('a decode failure after loadeddata cannot pass source-start preparation', async () => {
    const failed = await browser.newPage({ viewport: { width: 711, height: 900 } });
    watch(failed);
    const target = Object.values(clips).findIndex(clip => (clip.sourceStart ?? 0) === 0);
    assert.ok(target >= 0);
    try {
      await failed.addInitScript(target => {
        const create = Document.prototype.createElement; let index = 0;
        Document.prototype.createElement = function (tag, ...args) {
          const video = create.call(this, tag, ...args);
          if (tag.toLowerCase() === 'video' && index++ === target) video.addEventListener('loadeddata', () => {
            Object.defineProperty(video, 'error', { get: () => ({ code: 3, message: 'Controlled late decoder failure' }) });
          }, { once: true });
          return video;
        };
      }, target);
      await failed.goto(`${base}/film/`, { waitUntil: 'domcontentloaded' });
      await failed.waitForFunction(() => window.film?.mediaStatus === 'error', null, { timeout: 90000 });
      assert.equal(await failed.evaluate(() => window.film.ready.then(() => false, () => true)), true);
      assert.match(await failed.evaluate(() => window.film.mediaError), /could not be decoded/);
      assert.equal(await failed.locator('#media-error-panel').isVisible(), true);
      assert.equal(await failed.locator('#play').isDisabled(), true);
      assert.equal(await failed.locator('#retry-media').isEnabled(), true);
    } finally { await failed.close(); }
  });

  await check('reduced-motion preference and manual toggle', async () => {
    const gentle = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    const reviewTime = metadata.gentleReviewTime ?? (scenes[0].start + scenes[0].end) / 2;
    watch(gentle); await open(gentle, `?t=${reviewTime}`);
    assert.equal(await gentle.evaluate(() => window.film.reducedMotion), true);
    assert.equal(await gentle.locator('#motion').getAttribute('aria-pressed'), 'true');
    const first = await inspectFrame(gentle, reviewTime, 'gentle');
    assert.equal(await inspectFrame(gentle, Math.min(duration, reviewTime + .05), 'gentle-still'), first,
      'Reduced-motion footage and camera must be still within a shot');
    assert.ok((await gentle.evaluate(() => window.film.mediaState)).every(clip => clip.paused && clip.muted));
    await gentle.locator('#motion').click();
    assert.equal(await gentle.evaluate(() => window.film.reducedMotion), false);
    assert.equal(await gentle.locator('#motion').getAttribute('aria-pressed'), 'false');
    await gentle.close();
  });

  await check('phone canvas fits without overflow; controls remain usable', async () => {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true });
    watch(mobile); await open(mobile, `?t=${duration / 3}`);
    const geometry = await mobile.evaluate(() => {
      const canvas = document.getElementById('film-canvas'), rect = canvas.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
        visibleWidth: rect.width, visibleHeight: rect.height, width: canvas.width, height: canvas.height };
    });
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.visibleWidth >= 300 && geometry.visibleHeight > 0);
    assert.ok(Math.abs(geometry.width / geometry.height - geometry.visibleWidth / geometry.visibleHeight) < .02,
      'Canvas backing dimensions must match its visible aspect ratio');
    for (const time of representativeTimes) await inspectFrame(mobile, time, 'mobile');
    for (const id of ['play', 'replay', 'seek', 'motion', 'playback-speed']) {
      const control = mobile.locator(`#${id}`); await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, `${id} clips horizontally`);
      assert.ok(bounds.height >= 24, `${id} has a very small touch target`);
    }
    await mobile.evaluate(t => window.film.seek(t), duration / 3);
    await mobile.locator('#play').tap(); await mobile.waitForFunction(() => window.film.playing);
    await mobile.locator('#play').tap(); assert.equal(await mobile.evaluate(() => window.film.playing), false);
    await assertControlGeometry(mobile, '390px phone');
    await mobile.setViewportSize({ width: 320, height: 844 });
    await assertControlGeometry(mobile, '320px phone');
    await mobile.locator('#playback-speed').selectOption('5');
    assert.equal(await mobile.evaluate(() => window.film.playbackRate), 5);
    if (await mobile.evaluate(() => document.fullscreenEnabled)) {
      await mobile.locator('#fullscreen').tap(); await mobile.waitForFunction(() => !!document.fullscreenElement);
      await assertControlGeometry(mobile, '320px fullscreen', true);
      await mobile.locator('#fullscreen').tap(); await mobile.waitForFunction(() => !document.fullscreenElement);
    }
    await mobile.close();
  });
  await check('narrow desktop pane fits its canvas and controls without overflow', async () => {
    const pane = await browser.newPage({ viewport: { width: 711, height: 900 }, deviceScaleFactor: 1 });
    watch(pane); await open(pane, `?t=${duration / 3}`);
    const geometry = await pane.evaluate(() => {
      const canvas = document.getElementById('film-canvas'), rect = canvas.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
        width: rect.width, height: rect.height, playerBottom: document.getElementById('player').getBoundingClientRect().bottom };
    });
    assert.equal(geometry.overflow, false);
    assert.ok(geometry.height > 0);
    assert.ok(geometry.width >= 330, 'The stage should use the available width');
    assert.ok(geometry.playerBottom <= 900, 'Player controls should fit without scrolling');
    await assertControlGeometry(pane, '711px pane');
    for (const time of scenes.map(scene => (scene.start + scene.end) / 2)) await inspectFrame(pane, time, 'narrow-desktop');
    if (await pane.evaluate(() => document.fullscreenEnabled)) {
      await pane.locator('#fullscreen').click(); await pane.waitForFunction(() => !!document.fullscreenElement);
      await assertControlGeometry(pane, '711px fullscreen', true);
      await pane.locator('#fullscreen').click(); await pane.waitForFunction(() => !document.fullscreenElement);
    }
    await pane.close();
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
const failed = checks.filter(check => check.passed === false);
console.log(JSON.stringify({ passed: failed.length === 0, checks, duration, fps, stage: metadata?.stage,
  exportReady: metadata?.exportReady, downloadReady: metadata?.downloadReady, captureCount, clipCount: Object.keys(clips || {}).length, captureAssets,
  scope: captureCount === 0 && Object.keys(clips || {}).length === 0 ? 'engine-shell-only' : `${metadata?.stage || 'unknown'}-recorded-sources`,
  elapsedSeconds: Math.round((performance.now() - started) / 100) / 10,
  frames, screenshots, browserErrors, failedResources,
  note: 'Pixel and provenance checks cover rendering and source integrity. Human review is required for legibility, privacy, and a complete genuine recorded journey; a passing prototype is not a final delivery.' }));
process.exitCode = failed.length ? 1 : 0;
