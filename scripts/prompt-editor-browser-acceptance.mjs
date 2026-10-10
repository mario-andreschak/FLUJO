import { fork } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Run against an already-built checkout, with an isolated first-use data root:
// node scripts/prompt-editor-browser-acceptance.mjs <checkout> <port> <evidence>
// Uses native keyboard/clipboard events; never writes the editor's selection.
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 4397);
const evidence = path.resolve(process.argv[4]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
const require = createRequire(path.join(root, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-calendar-refresh-journey-'));
const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-calendar-refresh-secret-'));
const secret = path.join(secretDir, 'operator-secret');
await fs.writeFile(secret, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
await fs.mkdir(evidence, { recursive: true });
const baseURL = `http://127.0.0.1:${port}`;
const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP']);
const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
const env = { ...baseEnvironment, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  FLUJO_DATA_DIR: data, FLUJO_TELEMETRY_URL: baseURL + '/disabled-telemetry', FLUJO_BOOTSTRAP_DIR: path.join(data, 'bootstrap'),
  FLUJO_ENCRYPTION_SECRET_FILE: secret, FLUJO_RUNTIME_ENV_DIR: data, FLUJO_BASE_URL: baseURL,
  HOME: path.join(data, 'home'), USERPROFILE: path.join(data, 'home'),
  LOCALAPPDATA: path.join(data, 'home', 'local'), APPDATA: path.join(data, 'home', 'roaming') };
for (const name of ['HOME', 'LOCALAPPDATA', 'APPDATA']) await fs.mkdir(env[name], { recursive: true });
for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  try { await fs.access(path.join(root, name)); } catch(error) { if(error.code === 'ENOENT') continue; throw error; }
  throw new Error('Refuse candidate dotenv configuration');
}
const ownedRoots = new Map([[data, await fs.realpath(data)], [secretDir, await fs.realpath(secretDir)]]);
for (const name of ['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKSPACE', 'NEXT_MANUAL_SIG_HANDLE']) delete env[name];
const log = createWriteStream(path.join(evidence, 'app.log'));
const child = fork(path.join(root, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)],
  { cwd: root, env, silent: true, windowsHide: true });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
const receipt = { startedAt: new Date().toISOString(), root, baseURL, dataDir: data, secretDir, appPid: child.pid,
  buildId: (await fs.readFile(path.join(root, '.next/BUILD_ID'), 'utf8')).trim(),
  editorSourceSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'src/frontend/components/shared/GlobalReferenceEditor.tsx'))).digest('hex'),
  slateReactVersion: require('slate-react/package.json').version,
  lockSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex'),
  runtime: process.version, executable: process.execPath, checks: [], pageErrors: [], externalRequests: [] };
let browser;
const request = async (route, body) => {
  const response = await fetch(baseURL + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return response.json();
};
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('App initialization timeout')), 60000);
    child.once('error', reject); child.once('exit', code => reject(new Error(`Early app exit ${code}`)));
    child.on('message', message => {
      if (message?.type === 'journey-server-ready' && message.pid === child.pid) { clearTimeout(timeout); resolve(); }
    });
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
  await request('/api/storage', { key: 'mcp_servers', value: Object.fromEntries(Object.entries(configs.value ?? {})
    .map(([name, config]) => [name, { ...config, disabled: true }])) });
  const settings = await request('/api/storage?key=speech_settings');
  await request('/api/storage', { key: 'speech_settings', value: { ...settings.value,
    telemetry: { enabled: false, notifyDaily: false }, onboarding: { completed: true } } });

  browser = await chromium.launch({ headless: true });
  receipt.providerRequests = [];
  receipt.observations = [];
  for (const locale of ['en', 'es']) {
    for (const [size,width,height] of [['desktop',1440,1000],['phone',390,844]]) {
      const context = await browser.newContext({viewport:{width,height},locale:locale==='en'?'en-US':'es-CO',permissions:['clipboard-read','clipboard-write']});
      await context.addInitScript(value => localStorage.setItem('flujo.locale',value),locale);
      const page = await context.newPage();
      page.on('pageerror',error=>receipt.pageErrors.push(error.message));
      page.on('request',req=>{
        if(!req.url().startsWith(baseURL)&&!req.url().startsWith('data:')) receipt.externalRequests.push(req.url());
        if(/\/(model\/test|chat\/completions|responses)(?:[/?]|$)/.test(req.url())) receipt.providerRequests.push(req.url());
      });
      const conversationId='editor-'+locale+'-'+size;
      await request('/v1/chat/conversations',{id:conversationId,title:'Prompt editing check',flowId:'default-agent-flujo',messages:[],createdAt:Date.now(),updatedAt:Date.now()});
      await page.goto(baseURL+'/chat?conversation='+conversationId);
      const input=page.getByRole('textbox',{name:locale==='en'?'Message':'Mensaje',exact:true});
      const referenceButton=input.getByRole('button',{name:locale==='en'?'Remove global:EXAMPLE':'Quitar global:EXAMPLE',exact:true});
      await expect(input).toBeVisible();
      await input.evaluate(element => {
        window.promptEditorKeys = [];
        element.addEventListener('keydown', event => {
          if (['a', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            window.promptEditorKeys.push({ key: event.key, time: performance.now(),
              trusted: event.isTrusted, selected: window.getSelection()?.toString() });
          }
        }, true);
      });
      const selectionSnapshot = async stage => {
        const snapshot = await input.evaluate((element, stage) => {
          const selection = window.getSelection();
          return { stage, focused: document.activeElement === element,
            active: document.activeElement?.outerHTML.slice(0,300),
            text: element.innerText, selected: selection?.toString(),
            anchorText: selection?.anchorNode?.textContent, anchor: selection?.anchorOffset,
            focusText: selection?.focusNode?.textContent, focus: selection?.focusOffset,
            collapsed: selection?.isCollapsed };
        }, stage);
        receipt.selectionSnapshots ??= [];
        receipt.selectionSnapshots.push({locale,size,...snapshot});
      };
      await input.click();
      await page.keyboard.type('First');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('Second');
      await expect(input).toHaveText('FirstSecond');
      await page.keyboard.press('Control+z');
      for(let undo=0;undo<2&&(await input.innerText())!=='First';undo++) await input.press('Control+z');
      await expect(input).toHaveText('First');
      await selectionSnapshot('afterUndo');
      await page.evaluate(()=>navigator.clipboard.writeText('New '));
      for (let attempt = 0; attempt < 8; attempt++) {
        // No waits or assertions between Select All and the collapse key.
        await page.keyboard.press('Control+a');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Control+v');
        await expect(input).toHaveText('New First');
        await page.keyboard.press('Control+z');
        await expect(input).toHaveText('First');
      }
      await page.keyboard.press('Control+a');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('Typed ');
      await expect(input).toHaveText('Typed First');
      await page.keyboard.press('Control+z');
      await expect(input).toHaveText('First');
      await page.keyboard.press('Control+a');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.type('!');
      await expect(input).toHaveText('First!');
      await page.keyboard.press('Shift+ArrowLeft');
      await page.keyboard.type('?');
      await expect(input).toHaveText('First?');
      await page.keyboard.press('Control+z');
      await expect(input).toHaveText('First!');
      // Contiguous typing at the original end can share its history batch.
      // Remove the suffix natively rather than assuming one Undo per keystroke.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Backspace');
      await expect(input).toHaveText('First');
      for(let left=0;left<5;left++) await page.keyboard.press('ArrowLeft');
      await selectionSnapshot('beforeNewPaste');
      await expect.poll(()=>input.evaluate(element=>{
        const selection=window.getSelection();
        return document.activeElement===element && selection?.isCollapsed &&
          selection.anchorNode?.textContent==='First' && selection.anchorOffset===0;
      })).toBe(true);
      await page.evaluate(()=>navigator.clipboard.writeText('New '));
      await page.keyboard.press('Control+v');
      await expect(input).toHaveText('New First');
      await page.keyboard.press('Control+z');
      await expect(input).toHaveText('First');
      await page.keyboard.press('Control+Shift+z');
      await expect(input).toHaveText('New First');
      for(let right=0;right<9;right++) await page.keyboard.press('ArrowRight');
      await selectionSnapshot('beforeReferencePaste');
      await page.evaluate(()=>navigator.clipboard.writeText(' \u0024{global:EXAMPLE}'));
      await page.keyboard.press('Control+v');
      await expect(referenceButton).toBeVisible();
      await page.keyboard.press('Control+z');
      await expect(referenceButton).toHaveCount(0);
      await expect(input).toHaveText('New First');
      await page.keyboard.press('Control+Shift+z');
      await expect(referenceButton).toBeVisible();
      const before=await input.innerText();
      await input.evaluate(element=>{
        const data=new DataTransfer();data.setData('text/plain','UNEXPECTED');
        element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
      });
      await expect.poll(()=>input.innerText()).toBe(before);
      await expect.poll(()=>input.evaluate(element => document.activeElement === element)).toBe(true);
      const syntheticSelectAll = await input.evaluate(element => {
        const selection = window.getSelection();
        const before = { anchor: selection?.anchorOffset, focus: selection?.focusOffset,
          selected: selection?.toString() };
        const event = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA',
          ctrlKey: true, bubbles: true, cancelable: true });
        const unhandled = element.dispatchEvent(event);
        return { before, after: { anchor: selection?.anchorOffset, focus: selection?.focusOffset,
          selected: selection?.toString() }, unhandled, trusted: event.isTrusted };
      });
      if (!syntheticSelectAll.unhandled || syntheticSelectAll.trusted
        || JSON.stringify(syntheticSelectAll.before) !== JSON.stringify(syntheticSelectAll.after)) {
        throw new Error('Synthetic Select All acquired selection authority');
      }
      await page.evaluate(()=>navigator.clipboard.writeText('Replacement'));
      for (const modifier of ['Control', 'Meta']) {
        await page.keyboard.press(modifier + '+a');
        await page.keyboard.press('Control+v');
        await expect(input).toHaveText('Replacement');
        await expect(referenceButton).toHaveCount(0);
        await page.keyboard.press('Control+z');
        await expect(input).toHaveText(before);
        await expect(referenceButton).toBeVisible();
      }
      const keys = await page.evaluate(() => window.promptEditorKeys);
      const rapidPairs = keys.flatMap((key, index) => key.key === 'ArrowLeft'
        && keys[index - 1]?.key === 'a' ? [{ elapsedMs: key.time - keys[index - 1].time,
          selected: key.selected, trusted: key.trusted && keys[index - 1].trusted }] : []);
      if (rapidPairs.length !== 9 || rapidPairs.some(pair => !pair.trusted || pair.elapsedMs >= 100
        || pair.selected !== 'First')) throw new Error('Native rapid shortcut was not exercised: '+JSON.stringify(rapidPairs));
      const sizes=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
      if(sizes.scroll>sizes.viewport+1) throw new Error('Page overflow: '+JSON.stringify(sizes));
      receipt.observations.push({locale,size,rapidPairs,realPaste:true,rapidTyping:true,
        rightCollapse:true,shiftSelectionReplacement:true,focusRetained:true,
        undoRetainsPriorText:true,redo:true,referencePaste:true,syntheticPasteRejected:true,
        controlAndMetaSelectAll:true,syntheticSelectAllRejected:true,sizes});
      await page.screenshot({path:path.join(evidence,locale+'-'+size+'-editor.png'),fullPage:true,animations:'disabled'});
      await context.close();
    }
  }
  if(receipt.pageErrors.length||receipt.providerRequests.length||receipt.externalRequests.length) throw new Error('Unexpected browser requests/errors');
  receipt.checks.push('EN/ES desktop and phone: native rapid Select All/Left/paste and typing, Right collapse, Shift selection replacement, clipboard paste, Undo/redo, reference pills, focus retention, synthetic paste rejection, no overflow/provider calls');
  receipt.completedAt=new Date().toISOString();
  console.log(JSON.stringify({checks:receipt.checks,observations:receipt.observations}));
} catch (error) {
  if (browser) { try { const failedPage = browser.contexts()[0]?.pages()[0]; if(failedPage) { receipt.failureText = await failedPage.locator('body').innerText(); await failedPage.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}); } } catch {} }
  receipt.error = String(error.stack ?? error); process.exitCode = 1; console.error(receipt.error);
} finally {
  receipt.cleanupErrors = [];
  const cleanupError = error => { receipt.cleanupErrors.push(String(error)); process.exitCode = 1; };
  try { await browser?.close(); } catch (error) { cleanupError(error); }
  try {
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
      let forced;
      const timeout = setTimeout(() => {
        cleanupError('App graceful stop timeout'); child.kill('SIGKILL');
        forced = setTimeout(() => reject(new Error('Owned app termination timeout')), 5000);
      }, 30000);
      child.once('exit', () => { clearTimeout(timeout); clearTimeout(forced); resolve(); });
      child.send('stop', error => { if (error) cleanupError(error); });
    });
    if (![0, 143].includes(child.exitCode)) throw new Error(`App exit ${child.exitCode}/${child.signalCode}`);
  } catch (error) { cleanupError(error); }
  await new Promise(resolve => log.end(resolve));
  if (!receipt.cleanupErrors.length && !receipt.error) {
    for (const [target, expected] of ownedRoots) {
      try {
        const resolved = path.resolve(target);
        const actual = await fs.realpath(target);
        const parent = await fs.realpath(os.tmpdir());
        if (actual !== expected || resolved !== actual || path.dirname(actual) !== parent ||
          !/^flujo-calendar-refresh-(journey|secret)-[A-Za-z0-9]+$/.test(path.basename(actual))) {
          throw new Error('Refuse cleanup outside exact newly created temporary root');
        }
        await fs.rm(actual, {recursive:true,force:false});
        receipt.removedOwnedRoots ??= []; receipt.removedOwnedRoots.push(actual);
      } catch(error) { cleanupError(error); }
    }
  }
  receipt.appExitCode = child.exitCode; receipt.appSignalCode = child.signalCode; receipt.stoppedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ stopped: child.exitCode !== null || child.signalCode !== null, cleanupErrors: receipt.cleanupErrors }));
}
