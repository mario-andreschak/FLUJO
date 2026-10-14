// Focused transcript acceptance against an existing production build:
// node scripts/meeting-transcript-browser-acceptance.mjs <checkout> <port> <evidence>
import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

const root = path.resolve(process.argv[2] ?? process.cwd());
const port = Number(process.argv[3] ?? 4398);
const evidence = path.resolve(process.argv[4]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const require = createRequire(path.join(root, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const baseURL = `http://127.0.0.1:${port}`;
const fixtureRoot = path.join(evidence, 'fixtures');
const data = path.join(fixtureRoot, 'data');
const secretDir = path.join(fixtureRoot, 'secret');
await fs.mkdir(secretDir, { recursive: true });
await fs.mkdir(data, { recursive: true });
const secret = path.join(secretDir, 'operator-secret');
await fs.writeFile(secret, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase()))),
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', FLUJO_DATA_DIR: data,
  FLUJO_BOOTSTRAP_DIR: path.join(data, 'bootstrap'), FLUJO_TELEMETRY_URL: baseURL + '/disabled-telemetry',
  FLUJO_ENCRYPTION_SECRET_FILE: secret, FLUJO_RUNTIME_ENV_DIR: data, FLUJO_BASE_URL: baseURL,
  HOME: path.join(data, 'home'), USERPROFILE: path.join(data, 'home'),
  LOCALAPPDATA: path.join(data, 'home', 'local'), APPDATA: path.join(data, 'home', 'roaming') };
for (const name of ['HOME', 'LOCALAPPDATA', 'APPDATA']) await fs.mkdir(env[name], { recursive: true });
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  try { await fs.access(path.join(root, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  throw new Error('Refuse candidate dotenv configuration');
}
const operator = await createSmokeOperator();
Object.assign(env, operator.env, { FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_APP_ROOT: root });
const headers = { authorization: `Bearer ${operator.token}` };
const receipt = { startedAt: new Date().toISOString(), root, baseURL, fixtureRoot,
  operatorDir: path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE), runtime: process.version,
  buildId: (await fs.readFile(path.join(root, '.next/BUILD_ID'), 'utf8')).trim(),
  sourceSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'src/frontend/components/Meetings/MeetingTranscript.tsx'))).digest('hex'),
  lockSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex'),
  reactWindowVersion: require('react-window/package.json').version,
  checks: [], observations: [], pageErrors: [], externalRequests: [], providerRequests: [] };
const log = createWriteStream(path.join(evidence, 'app.log'));
const child = fork(path.join(root, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], { cwd: root, env, silent: true, windowsHide: true });
receipt.appPid = child.pid;
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const request = async (route, body) => {
  const response = await fetch(baseURL + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return response.json();
};
async function seedMeeting(id, empty = false) {
  const now = Date.now();
  const meeting = { version: 1, id, title: 'Transcript maintenance check', openingPrompt: 'Compare the two launch dates.',
    status: empty ? 'draft' : 'completed', phase: empty ? 'draft' : 'completed',
    participants: ['ava', 'luis'].map((person, index) => ({ id: person, name: index ? 'Luis' : 'Ava',
      flowId: 'default-agent-flujo', conversationId: id + '-' + person, role: 'participant', status: 'idle', lastDeliveredSeq: -1 })),
    policy: { roundMode: 'barrier', entryMode: 'start-each-round', maxRounds: 6, concurrencyLimit: 4,
      errorStrategy: 'collect-all', moderatorMode: 'none', finishThreshold: 'majority', allSilentBehavior: 'finish' },
    roundNumber: empty ? 0 : 1, motions: [], lastEventSeq: -1, createdAt: now, updatedAt: now };
  const events = [];
  const add = event => events.push({ version: 1, meetingId: id, eventId: `${id}:${events.length}`, seq: events.length,
    timestamp: now + events.length, audience: 'public', ...event });
  if (!empty) {
    add({ type: 'meeting:started' });
    add({ type: 'round:started', roundId: 'round-one', round: { id: 'round-one', number: 1, phase: 'discussion',
      status: 'completed', snapshotSeq: 0, eligibleParticipantIds: ['ava', 'luis'], participantTurnIds: {} } });
    add({ type: 'participant:spoke', roundId: 'round-one', participantId: 'ava', participantName: 'Ava', turnId: 'first',
      content: 'We should compare the two dates.', media: [{ type: 'image', name: 'Launch chart', url: baseURL + '/transcript-attachment.svg' }] });
    add({ type: 'participant:spoke', roundId: 'round-one', participantId: 'luis', participantName: 'Luis', turnId: 'second', content: 'Allow time to check the plan.' });
    add({ type: 'participant:error', roundId: 'round-one', participantId: 'luis', participantName: 'Luis', error: 'Please retry the connection.' });
    add({ type: 'motion:opened', roundId: 'round-one', motion: { id: 'motion-one', kind: 'finish', proposal: 'Agree on the launch date.',
      proposedByParticipantId: 'ava', roundId: 'round-one', status: 'open', votes: [], createdAt: now } });
    add({ type: 'vote:cast', roundId: 'round-one', motionId: 'motion-one', participantId: 'luis', choice: 'yes' });
    add({ type: 'motion:resolved', roundId: 'round-one', motionId: 'motion-one', outcome: 'accepted', tally: { yes: 2, no: 0, abstain: 0 } });
    for (let index = 0; index < 30; index++) add({ type: 'participant:spoke', roundId: 'round-one', participantId: index % 2 ? 'luis' : 'ava',
      participantName: index % 2 ? 'Luis' : 'Ava', turnId: `turn-${index}`, content: `Contribution ${index + 1}.\n\n` + 'Compare the dates and leave enough time for review. '.repeat(index % 3 ? 5 : 22) });
    add({ type: 'meeting:completed', reason: 'Discussion finished.' });
  }
  meeting.lastEventSeq = events.length - 1;
  const db = path.join(data, 'workspaces/default-workspace/db');
  await fs.mkdir(path.join(db, 'meetings'), { recursive: true });
  await fs.mkdir(path.join(db, 'meeting-logs'), { recursive: true });
  await fs.writeFile(path.join(db, 'meetings', id + '.json'), JSON.stringify(meeting));
  await fs.writeFile(path.join(db, 'meeting-logs', id + '.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''));
  return { meeting, events };
}
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('App initialization timeout')), 60000);
    child.once('error', reject); child.once('exit', code => reject(new Error(`Early app exit ${code}`)));
    child.on('message', message => { if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clearTimeout(timeout); resolve(); } });
  });
  const readyDeadline = Date.now() + 60000;
  for (;;) {
    try { await request('/api/workspaces'); break; }
    catch (error) {
      if (Date.now() >= readyDeadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const configs = await request('/api/storage?key=mcp_servers');
  await request('/api/storage', { key: 'mcp_servers', value: Object.fromEntries(Object.entries(configs.value ?? {}).map(([name, config]) => [name, { ...config, disabled: true }])) });
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value, telemetry: { enabled: false, notifyDaily: false }, onboarding: { completed: true } } });
  browser = await chromium.launch({ headless: true,
    ...(process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE ? { executablePath: process.env.FLUJO_ACCEPTANCE_BROWSER_EXECUTABLE } : {}),
  });
  receipt.browserVersion = browser.version();
  for (const [size, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const id = 'transcript-' + size;
    await seedMeeting(id);
    await seedMeeting(id + '-empty', true);
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', extraHTTPHeaders: headers });
    await context.addInitScript(() => localStorage.setItem('flujo.locale', 'en'));
    const page = await context.newPage();
    page.on('pageerror', error => receipt.pageErrors.push(error.message));
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(baseURL + '/') && !url.startsWith('data:')) { receipt.externalRequests.push(url); await route.abort(); }
      else if (/\/(model\/test|chat\/completions|responses)(?:[/?]|$)/.test(url)) { receipt.providerRequests.push(url); await route.abort(); }
      else await route.continue();
    });
    let releaseAttachment;
    const attachmentReady = new Promise(resolve => { releaseAttachment = resolve; });
    await page.route(baseURL + '/transcript-attachment.svg', async route => {
      await attachmentReady;
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"><rect width="240" height="180" fill="#416cb0"/></svg>' }).catch(error => { if (!route.request().failure()) throw error; });
    });
    await page.goto(baseURL + '/meetings?meeting=' + id, { waitUntil: 'domcontentloaded' });
    const paper = page.getByRole('heading', { name: 'Conversation', exact: true }).locator('..').locator('..');
    const list = paper.getByRole('list', { name: 'Conversation', exact: true });
    await expect(list).toBeVisible();
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await paper.getByRole('button', { name: 'Live', exact: true }).click();
    await list.evaluate(element => element.scrollTo({ top: 0 }));
    const row = text => list.getByRole('listitem').filter({ has: page.getByText(text, { exact: true }) });
    const first = row('We should compare the two dates.');
    const next = row('Allow time to check the plan.');
    await expect(first).toBeVisible();
    const beforeLoad = await first.evaluate(element => element.getBoundingClientRect().height);
    releaseAttachment();
    await expect(first.getByRole('img', { name: 'Launch chart' })).toBeVisible();
    await expect.poll(() => first.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(beforeLoad + 100);
    const aligned = async () => {
      const a = await first.evaluate(element => ({ outer: element.getBoundingClientRect().height, content: element.firstElementChild.getBoundingClientRect().height, bottom: element.getBoundingClientRect().bottom }));
      const b = await next.evaluate(element => element.getBoundingClientRect().top);
      return Math.abs(a.outer - Math.ceil(a.content)) <= 1 && b >= a.bottom - 1 && b <= a.bottom + 2;
    };
    await expect.poll(aligned).toBe(true);
    await first.evaluate(element => { window.transcriptPinnedRow = element; });
    await paper.getByRole('button', { name: /^A\s*Ava$/ }).click();
    await expect.poll(() => first.evaluate(element => element === window.transcriptPinnedRow)).toBe(true);
    await paper.getByRole('button', { name: 'Errors only', exact: true }).click();
    await expect(paper.getByRole('heading', { name: 'No events match these filters' })).toBeVisible();
    await paper.getByRole('button', { name: 'Clear transcript filters', exact: true }).click();
    await expect(list).toBeVisible();
    await expect.poll(aligned).toBe(true);
    await paper.getByRole('button', { name: 'Errors only', exact: true }).click();
    await expect(list.getByText(/Please retry the connection\./)).toBeVisible();
    await paper.getByRole('button', { name: 'Motions only', exact: true }).click();
    await expect(list.getByText('Agree on the launch date.', { exact: true })).toBeVisible();
    await paper.getByRole('button', { name: 'Clear transcript filters', exact: true }).click();
    const expandedHeight = await first.evaluate(element => element.getBoundingClientRect().height);
    const summary = first.getByRole('button', { name: /Ava/ });
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => first.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(expandedHeight - 100);
    await expect.poll(aligned).toBe(true);
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(aligned).toBe(true);
    await page.setViewportSize({ width: size === 'desktop' ? 390 : 360, height: 844 });
    await expect.poll(aligned).toBe(true);
    const resized = await first.evaluate(element => ({ outer: element.getBoundingClientRect().height, content: element.firstElementChild.getBoundingClientRect().height }));
    await page.setViewportSize({ width, height });
    await expect.poll(aligned).toBe(true);
    const saveNote = async content => {
      await page.getByRole('textbox', { name: 'Continue with prompt', exact: true }).fill(content);
      const response = page.waitForResponse(value => new URL(value.url()).pathname === '/v1/meetings/' + id + '/private-notes' && value.request().method() === 'POST');
      await page.getByRole('button', { name: 'Private note', exact: true }).click();
      const saved = await response;
      if (saved.status() !== 201 || (await saved.json()).event.content !== content) throw new Error('Private note was not persisted');
      await expect(page.getByText('Private note saved to the meeting log.', { exact: true })).toBeVisible();
    };
    await list.evaluate(element => element.scrollTo({ top: 0 }));
    await saveNote('Paused reader note.');
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
    await paper.getByRole('button', { name: 'Paused', exact: true }).click();
    await expect(list.getByText('Paused reader note.', { exact: true })).toBeVisible();
    const followedTop = await list.evaluate(element => element.scrollTop);
    await saveNote('Live reader note.');
    await expect(list.getByText('Live reader note.', { exact: true })).toBeVisible();
    await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(followedTop);
    const announcement = await paper.getByRole('status').boundingBox();
    if (!announcement || announcement.width > 1 || announcement.height > 1) throw new Error('Live announcement changes page layout');
    try {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    } catch (error) {
      receipt.overflowElements = await page.evaluate(() => [...document.querySelectorAll('body *')].flatMap(element => {
        const rect = element.getBoundingClientRect();
        if (rect.right <= document.documentElement.clientWidth + 1 || !rect.width) return [];
        const style = getComputedStyle(element);
        return [{ tag: element.tagName, className: String(element.className).slice(0, 200),
          role: element.getAttribute('role'), left: rect.left, right: rect.right, width: rect.width,
          position: style.position, overflow: style.overflow, transform: style.transform }];
      }).slice(0, 30));
      throw error;
    }
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    await page.screenshot({ path: path.join(evidence, size + '-transcript.png'), fullPage: true, animations: 'disabled' });
    await page.goto(baseURL + '/meetings?meeting=' + id + '-empty', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'The room is getting ready' })).toBeVisible();
    receipt.observations.push({ size, width, imageLoad: true, alignedRows: true, stableFilteredRow: true,
      noMatchRecovery: true, errorsAndMotions: true, keyboardCollapse: true, resized,
      pausedAppend: true, liveAppend: true, persistedNotes: true, waiting: true, sizes });
    await context.close();
  }
  if (receipt.pageErrors.length || receipt.externalRequests.length || receipt.providerRequests.length) throw new Error('Unexpected browser requests or errors');
  receipt.checks.push('Desktop/phone: delayed image layout, filtering and stable keys, error/motion/no-match recovery, keyboard collapse, responsive measurement, waiting state, real persisted private notes with Live/Paused scrolling; no overflow or provider calls');
  receipt.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ checks: receipt.checks, observations: receipt.observations }));
} catch (error) {
  receipt.error = String(error.stack ?? error); process.exitCode = 1;
  try { const failed = browser?.contexts()[0]?.pages()[0]; if (failed) { receipt.failureText = await failed.locator('body').innerText(); await failed.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }); } } catch {}
  console.error(receipt.error);
} finally {
  receipt.cleanupErrors = [];
  try { await browser?.close(); } catch (error) { receipt.cleanupErrors.push(String(error)); }
  try {
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Owned app graceful stop timeout')); }, 30000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); }); child.send('stop', error => { if (error) reject(error); });
    });
    if (![0, 143].includes(child.exitCode)) throw new Error(`App exit ${child.exitCode}/${child.signalCode}`);
  } catch (error) { receipt.cleanupErrors.push(String(error)); }
  await new Promise(resolve => log.end(resolve));
  receipt.appExitCode = child.exitCode; receipt.stoppedAt = new Date().toISOString();
  if (receipt.cleanupErrors.length) process.exitCode = 1;
  // The owner removes fixtureRoot and operatorDir through flujo-bash after inspection.
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ stopped: child.exitCode !== null || child.signalCode !== null, cleanupErrors: receipt.cleanupErrors, fixtureRoot }));
}
