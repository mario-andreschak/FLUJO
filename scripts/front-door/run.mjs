#!/usr/bin/env node
// In-chat app views through a signed-in front door (#1336), as one repeatable check. A throwaway
// FLUJO from the production build runs in Localhost mode, started the way the documented
// deployment starts it (docs/start-here/network.md), behind a local HTTPS front door that needs a
// sign-in cookie (proxy.mjs). A browser signs in, opens a chat with an agent whose app has an app
// view, sends a message, and the view must render from the front door's sandbox address. A free
// local stub model answers, so no account or key is needed. Run `npm run build` first.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_DIR, loadChromium, parseArgs, parseViewport, runStep, save } from '../flujo-drive.mjs';
import { startProductionFlujo } from '../first-journey/production.mjs';
import { STUB_FINAL_PREFIX, STUB_MODEL_ID, startStubModel } from '../first-journey/stub-model.mjs';
import { appUri, createAppsFixture } from '../mcp-apps-browser-fixture.mjs';
import { selfSignedCertificate } from './certificate.mjs';
import { SESSION_COOKIE, startFrontDoor } from './proxy.mjs';

/** Browsers reach the front door under this name; Chromium maps it to 127.0.0.1. */
export const HOSTNAME = 'flujo.test';
export const NAMES = Object.freeze({
  model: 'front-door-model',
  server: 'front-door-app',
  flow: 'front-door-agent',
  agent: 'Front door agent',
  question: 'Show the app view: please use open_view',
});
const WAIT = 120_000;

export const USAGE = `Usage: node scripts/front-door/run.mjs [--viewport WxH] [--out FOLDER]

Starts a throwaway FLUJO from the production build ("npm run build" first) in Localhost mode with
the documented front door settings, puts a local HTTPS front door with a sign-in in front of it,
and checks in a browser that an app view shows in a chat opened through that front door.
Screenshots, an accessibility snapshot, FLUJO's log and report.json are saved under
${path.join(EVIDENCE_DIR, 'front-door')}. Exit code 0 means every check passed.`;

/** FLUJO's startup line for the front door settings, or undefined when it did not write one. */
export function frontDoorStartupLine(logText, { sandboxOrigin, dashboardOrigin }) {
  return logText.split(/\r?\n/).find((line) => line.includes('MCP Apps sandbox (localhost mode): requests through the front door use')
    && line.includes(`shared address ${sandboxOrigin}/sandbox.html`) && line.includes(`extra dashboard origins ${dashboardOrigin}`));
}

/** What a browser on another network can reach: the front door's two addresses and in-page content. */
export function reachableThroughFrontDoor(url, { dashboardOrigin, sandboxOrigin }) {
  return ['data:', 'blob:', 'about:'].includes(url.protocol) || [dashboardOrigin, sandboxOrigin].includes(url.origin);
}

const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: `${type} node`, properties } });
const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id, target: target.id,
  sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });

/** start -> process -> finish, with the app's `open_view` tool on the process step. */
export function agentFlow() {
  const nodes = [
    node('start', 'start', { promptTemplate: 'You show app views when asked.' }),
    node('process', 'process', { boundModel: NAMES.model, inputMode: 'full-history', allowQuestion: false,
      promptTemplate: 'Use the tool the user names.' }),
    node('finish', 'finish'),
    node('tools', 'mcp', { boundServer: NAMES.server, enabledTools: ['open_view'], enabledResources: 'all' }),
  ];
  return { id: NAMES.flow, name: NAMES.agent, updatedAt: Date.now(), nodes,
    edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2]),
      { id: 'tools-process', source: 'tools', target: 'process', type: 'custom', data: { edgeType: 'mcp' } }] };
}

async function api(baseUrl, route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(route, baseUrl), {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(WAIT),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

/** The app's view inside the sandbox, once it is ready and has its tool result. */
async function readyView(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const state = await frame.evaluate(() => (window.appReceipt
      ? { status: document.getElementById('status')?.textContent, events: window.appReceipt.events } : null)).catch(() => null);
    if (state?.status === 'Ready' && state.events.includes('ui/notifications/tool-result')) return frame;
  }
  return undefined;
}

async function waitForView(page) {
  const deadline = Date.now() + WAIT;
  for (;;) {
    const frame = await readyView(page);
    if (frame) return frame;
    // A view that waits for one click (Settings → MCP Apps) is opened the way a person would.
    for (const name of ['Open app', 'Allow once']) {
      const button = page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
      if (await button.count()) await button.click().catch(() => undefined);
    }
    if (Date.now() > deadline) throw new Error(`The app view did not show within ${WAIT / 1000}s.`);
    await page.waitForTimeout(500);
  }
}

/** Each check acts like a user, or reads what FLUJO wrote for its operator. */
export const CHECKS = [
  {
    id: 'startup-line',
    title: 'FLUJO names the front door addresses in one startup line',
    async run({ instance, frontDoor, notes }) {
      const deadline = Date.now() + WAIT;
      for (;;) {
        const line = frontDoorStartupLine(readFileSync(instance.logFile, 'utf8'), frontDoor);
        if (line) { notes.startupLine = line.trim(); return; }
        if (Date.now() > deadline) throw new Error('FLUJO wrote no startup line naming the front door sandbox address.');
        await new Promise((resolve) => { setTimeout(resolve, 1_000); });
      }
    },
  },
  {
    id: 'this-computer',
    title: 'A browser on this computer keeps the local app view address',
    async run({ instance, notes }) {
      const answer = await api(instance.baseUrl, `/api/mcp/app-sandbox?${new URLSearchParams({ serverName: NAMES.server, uri: appUri })}`);
      const local = new URL(answer.url);
      if (local.protocol !== 'http:' || !local.hostname.endsWith('.localhost')) throw new Error(`This computer got ${local.origin}, not <app>.localhost.`);
      notes.localSandboxOrigin = local.origin;
    },
  },
  {
    id: 'sign-in',
    title: 'The front door asks for the sign-in, then opens the chat',
    async run({ page, frontDoor, log }) {
      await page.goto(`${frontDoor.dashboardOrigin}/chat?flow=${encodeURIComponent(NAMES.flow)}`, { timeout: WAIT });
      await runStep(page, { do: 'expect-text', text: 'Sign in to FLUJO' }, frontDoor.dashboardOrigin, log);
      await runStep(page, { do: 'fill', label: 'Password', value: frontDoor.password }, frontDoor.dashboardOrigin, log);
      await runStep(page, { do: 'click', role: 'button', name: 'Sign in' }, frontDoor.dashboardOrigin, log);
      await runStep(page, { do: 'wait-for', role: 'textbox', name: 'Message', timeout: WAIT }, frontDoor.dashboardOrigin, log);
      if (frontDoor.stats.signIns !== 1) throw new Error('The front door did not record exactly one sign-in.');
    },
  },
  {
    id: 'chat-app-view',
    title: 'A chat through the front door shows the app view from the front door sandbox address',
    async run({ page, frontDoor, log, notes }) {
      await runStep(page, { do: 'fill', label: 'Message', value: NAMES.question, exact: true }, frontDoor.dashboardOrigin, log);
      await runStep(page, { do: 'click', role: 'button', name: 'Send message' }, frontDoor.dashboardOrigin, log);
      await runStep(page, { do: 'expect-text', text: STUB_FINAL_PREFIX, timeout: WAIT }, frontDoor.dashboardOrigin, log);
      const view = await waitForView(page);
      const sandbox = view.parentFrame();
      if (!sandbox || sandbox === page.mainFrame()) throw new Error('The app view is not inside FLUJO\'s sandbox frame.');
      notes.sandboxOrigin = new URL(sandbox.url()).origin;
      if (notes.sandboxOrigin !== frontDoor.sandboxOrigin) {
        throw new Error(`The app view came from ${notes.sandboxOrigin}, not the front door sandbox address ${frontDoor.sandboxOrigin}.`);
      }
      if (frontDoor.stats.sandboxAddressRequests < 1 || frontDoor.stats.sandboxForwarded < 1) {
        throw new Error('The sandbox address and the sandbox page did not both pass through the front door.');
      }
      // The sandbox shares the dashboard's host name, so browsers send it the sign-in cookie too;
      // HttpOnly keeps it out of reach of the app's scripts (docs/features/mcp/apps.md).
      for (const frame of [sandbox, view]) {
        const cookies = await frame.evaluate(() => { try { return document.cookie; } catch { return ''; } });
        if (cookies.includes(SESSION_COOKIE)) throw new Error('Scripts in the app view sandbox can read the front door sign-in cookie.');
      }
      notes.viewStatus = await view.locator('#status').textContent();
    },
  },
];

export async function runCheck({ viewport, out, log = console.log, start = startProductionFlujo }) {
  const evidence = path.join('front-door', out);
  const evidenceDir = path.join(EVIDENCE_DIR, evidence);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const report = { startedAt: new Date().toISOString(), viewport, checks: [], notes: {}, problems: [] };
  const password = randomBytes(18).toString('base64url');
  const certificate = selfSignedCertificate(HOSTNAME);
  const opened = {};
  let passed = false;
  try {
    const stub = opened.stub = await startStubModel();
    const apps = opened.apps = await createAppsFixture();
    opened.frontDoor = await startFrontDoor({ hostname: HOSTNAME, password, certificate });
    const frontDoor = { ...opened.frontDoor, password };
    report.frontDoor = { dashboardOrigin: frontDoor.dashboardOrigin, sandboxOrigin: frontDoor.sandboxOrigin };
    opened.instance = await start({ logFile: path.join(evidenceDir, 'flujo.log'), log, env: {
      FLUJO_EXPOSURE_MODE: 'localhost',
      FLUJO_MCP_APP_SANDBOX_PUBLIC_URL: `${frontDoor.sandboxOrigin}/sandbox.html`,
      FLUJO_MCP_APP_HOST_ORIGINS: frontDoor.dashboardOrigin,
    } });
    const instance = opened.instance;
    opened.frontDoor.connect({ upstream: instance.baseUrl, sandboxUpstream: `http://127.0.0.1:${instance.sandboxPort}` });
    await api(instance.baseUrl, '/api/init');
    await api(instance.baseUrl, '/api/model', { id: NAMES.model, name: STUB_MODEL_ID, displayName: 'Front door stub AI',
      provider: 'openai', adapter: 'openai', ApiKey: 'stand-in-key-not-a-secret', baseUrl: stub.url });
    await api(instance.baseUrl, '/api/mcp/servers', { name: NAMES.server, transport: 'streamable', serverUrl: `${apps.origin}/modern`,
      disabled: false, enableMcpApps: true });
    await api(instance.baseUrl, '/api/flow', agentFlow());

    opened.browser = await loadChromium({ args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`] });
    const context = await opened.browser.newContext({ viewport, locale: 'en-US', ignoreHTTPSErrors: true });
    await context.addInitScript(() => { try { localStorage.setItem('flujo.locale', 'en'); } catch { /* storage blocked */ } });
    // Like a phone on another network, the browser reaches only the front door: never
    // FLUJO's own ports or an `<app>.localhost` address of the machine it runs on.
    report.notes.blockedRequests = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (reachableThroughFrontDoor(url, frontDoor)) return route.continue();
      report.notes.blockedRequests.push(url.origin);
      return route.abort('addressunreachable');
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.problems.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') report.problems.push(`console error: ${message.text().slice(0, 300)}`);
    });
    for (const check of CHECKS) {
      const started = Date.now();
      try {
        await check.run({ page, instance, frontDoor, log, notes: report.notes });
        report.checks.push({ id: check.id, ok: true, seconds: (Date.now() - started) / 1000 });
        log(`✓ ${check.title}`);
      } catch (error) {
        report.checks.push({ id: check.id, ok: false, seconds: (Date.now() - started) / 1000, error: error.message.split('\n')[0] });
        log(`✗ ${check.title}: ${error.message.split('\n')[0]}`);
        await save(page, 'shot', path.join(evidence, `${check.id}-failed.png`), log).catch(() => undefined);
        break;
      }
    }
    await save(page, 'shot', path.join(evidence, 'chat-app-view.png'), log).catch(() => undefined);
    await save(page, 'aria', path.join(evidence, 'chat-app-view.yml'), log).catch(() => undefined);
    const pageErrors = report.problems.filter((problem) => problem.startsWith('page error:'));
    passed = report.checks.length === CHECKS.length && report.checks.every((check) => check.ok) && pageErrors.length === 0;
    if (pageErrors.length) log(`✗ ${pageErrors.length} error(s) crashed code on the page`);
  } finally {
    report.frontDoorStats = opened.frontDoor?.stats;
    report.stubCalls = opened.stub?.events.map(({ kind, offeredTools, calledTools, answered }) => ({ kind, offeredTools, calledTools, answered }));
    for (const close of [() => opened.browser?.close(), () => opened.instance?.stop(), () => opened.frontDoor?.close(),
      () => opened.apps?.close(), () => opened.stub?.close()]) {
      try { await close(); } catch (error) { report.problems.push(`cleanup: ${error.message}`); }
    }
    writeFileSync(path.join(evidenceDir, 'report.json'), `${JSON.stringify({ ...report, finishedAt: new Date().toISOString(), passed }, null, 2)}\n`);
    log(`Report: ${path.join(evidenceDir, 'report.json')}`);
  }
  for (const problem of report.problems.slice(0, 20)) log(`! ${problem}`);
  log(passed ? 'The app view showed in a chat through the signed-in front door.' : 'The front door check failed.');
  return passed ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const { options } = parseArgs(['run', ...argv]);
  if (options.help) { log(USAGE); return 0; }
  const viewport = parseViewport(options.viewport);
  const out = typeof options.out === 'string' ? options.out : `${viewport.width}x${viewport.height}`;
  if (!/^[\w-][\w.-]*$/.test(out) || out.includes('..')) throw new Error(`--out must be a plain folder name such as "phone", got "${out}".`);
  return runCheck({ viewport, out, log });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
