import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectCodexAllowance, normalizeCodexAllowance, readOwnedCodexAllowance } from '@/backend/services/model/allowance/codex';
import { readCodexAuthForTransfer } from '@/backend/services/model/adapters/codexAuth';
import { prepareCodexRuntimeEnvironment } from '@/backend/services/model/adapters/codexRuntimeHome';
import * as ownedTransport from '@/backend/services/model/adapters/codexAppServerProcess';

jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => { const actual = jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess'); return { ...actual, startOwnedCodexAppServer: jest.fn(actual.startOwnedCodexAppServer) }; });
jest.mock('@/backend/services/model/adapters/codexAuth', () => ({ readCodexAuthForTransfer: jest.fn() }));
jest.mock('@/backend/services/model/adapters/codexRuntimeHome', () => ({ prepareCodexRuntimeEnvironment: jest.fn() }));
jest.mock('@openai/codex-sdk', () => ({ Codex: class { exec = { executablePath: process.execPath }; } }), { virtual: true });

const fixture = `const fs=require('node:fs'),rl=require('node:readline');
const [log,mode]=process.argv.slice(1);fs.writeFileSync(log+'.pid',String(process.pid));
process.stdin.on('end',()=>process.exit(0));
rl.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);fs.appendFileSync(log,line+'\\n');if(m.id===undefined)return;
if(mode==='silent'&&m.method==='account/rateLimits/read')return;
let result={};if(m.method==='account/read')result={account:{type:mode==='api'?'apiKey':'chatgpt',email:'never-export@example.invalid'}};
if(m.method==='account/rateLimits/read')result={accountId:mode==='changed'?'other-account':'synthetic-account',rateLimits:{primary:{usedPercent:25,resetsAt:1791600000,windowDurationMins:300}}};
process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;
let root: string;
beforeEach(async () => { jest.clearAllMocks(); jest.mocked(ownedTransport.startOwnedCodexAppServer).mockImplementation(jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess').startOwnedCodexAppServer); root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-codex-allowance-')); });
afterEach(async () => {
  jest.restoreAllMocks();
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-codex-allowance-')) throw new Error('Unsafe allowance fixture cleanup');
  await fs.rm(root, { recursive: true, force: true });
});
function options(mode = 'normal', signal = new AbortController().signal) {
  return { executable: process.execPath, args: ['-e', fixture, path.join(root, 'wire'), mode],
    runtime: { home: root, workingDirectory: root, env: { ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot! } : {}) } },
    signal, timeoutMs: 1000, expectedAccountId: 'synthetic-account' };
}
async function assertClosed() {
  const pid = Number(await fs.readFile(path.join(root, 'wire.pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}

test('prefers all authoritative quota buckets, preserves nulls, and does not invent model families', () => {
  const snapshot = normalizeCodexAllowance({ rateLimits: { primary: { usedPercent: 0 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 25, resetsAt: 1791600000, windowDurationMins: 300 }, secondary: { usedPercent: 50 } },
    other: { limitName: 'Other quota', primary: { usedPercent: 110, resetsAt: null } },
    missing: { primary: {} },
  } });
  expect(snapshot.windows.map(row => row.remainingPercent)).toEqual([75, 50, 0, null]);
  expect(snapshot.windows[0].resetAt).toBe(new Date(1791600000 * 1000).toISOString());
  expect(snapshot.windows[1].resetAt).toBeNull();
  expect(snapshot.windows.every(row => row.modelFamily === undefined)).toBe(true);
  expect(normalizeCodexAllowance(null).windows).toEqual([]);
  expect(normalizeCodexAllowance({ rateLimitsByLimitId: {}, rateLimits: { primary: { usedPercent: 0 } } }).windows).toEqual([]);
});

test('real owned child reads account quota only, suppresses identity output, and closes', async () => {
  const snapshot = await readOwnedCodexAllowance(options());
  expect(snapshot.windows[0].remainingPercent).toBe(75);
  expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-account|never-export/);
  const messages = (await fs.readFile(path.join(root, 'wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(messages.map(row => row.method)).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  expect(messages[2].params).toEqual({ refreshToken: false });
  expect(messages[3].params).toEqual({ excludeResetCreditDetails: true });
  await assertClosed();
});

test.each(['api', 'changed'])('refuses %s account evidence and drains process closure', async mode => {
  await expect(readOwnedCodexAllowance(options(mode))).rejects.toThrow(/CODEX_ALLOWANCE_/);
  await assertClosed();
});

test('an unanswered quota request reaches its original bounded timeout and closes the owned child', async () => {
  await expect(readOwnedCodexAllowance(options('silent'))).rejects.toThrow('unavailable');
  await assertClosed();
});

test('abort while quota read awaits closes child without a model request', async () => {
  const controller = new AbortController();
  const pending = readOwnedCodexAllowance({ ...options('silent', controller.signal), timeoutMs: 5000 });
  const abort = async () => {
    for (let n = 0; n < 100; n++) {
      const wire = await fs.readFile(path.join(root, 'wire'), 'utf8').catch(() => '');
      if (wire.includes('account/rateLimits/read')) { controller.abort(); return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    controller.abort();
  };
  await Promise.all([expect(pending).rejects.toThrow(), abort()]);
  await assertClosed();
});

test('pre-aborted refresh never reads credentials or starts a process', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(collectCodexAllowance({ signal: controller.signal })).rejects.toThrow('CODEX_ALLOWANCE_UNAVAILABLE');
  expect(readCodexAuthForTransfer).not.toHaveBeenCalled();
});

function syntheticLogin() {
  jest.mocked(readCodexAuthForTransfer).mockImplementation(async () => Buffer.from(JSON.stringify({ tokens: { account_id: 'synthetic-account', access_token: 'synthetic-only' } })));
  jest.mocked(prepareCodexRuntimeEnvironment).mockResolvedValue(options().runtime);
}

test('production wrapper binds opaque login revision and closes its synthetic child', async () => {
  syntheticLogin();
  const start = jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess').startOwnedCodexAppServer as typeof ownedTransport.startOwnedCodexAppServer;
  jest.mocked(ownedTransport.startOwnedCodexAppServer).mockImplementation(input => {
    expect(path.isAbsolute(input.executable)).toBe(true);
    expect(input.executable).toBe(process.execPath);
    return start({ ...input, executable: process.execPath, args: options().args });
  });
  const result = await collectCodexAllowance({ timeoutMs: 5000 });
  expect(result.accountKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-account|synthetic-only|never-export/);
  expect(result.snapshot.windows[0].remainingPercent).toBe(75);
  expect(prepareCodexRuntimeEnvironment).toHaveBeenCalledWith(true);
  await assertClosed();
});

test('pinned installed SDK actually resolves the native CLI without starting it or accessing an account', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    'import {Codex} from "@openai/codex-sdk";import {statSync} from "node:fs";const c=new Codex();if(!statSync(c.exec.executablePath).isFile())throw Error("missing native CLI");console.log(JSON.stringify(c.exec.executablePath));'],
  { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 5000 });
  expect(JSON.parse(result)).toMatch(/codex(?:\.exe)?$/);
});

test('production wrapper refuses observations after authoritative login changes', async () => {
  syntheticLogin();
  jest.mocked(readCodexAuthForTransfer).mockResolvedValueOnce(Buffer.from('{"tokens":{"account_id":"synthetic-account"},"revision":1}'));
  const start = jest.requireActual('@/backend/services/model/adapters/codexAppServerProcess').startOwnedCodexAppServer as typeof ownedTransport.startOwnedCodexAppServer;
  jest.mocked(ownedTransport.startOwnedCodexAppServer).mockImplementation(input => start({ ...input, executable: process.execPath, args: options().args }));
  await expect(collectCodexAllowance({ timeoutMs: 5000 })).rejects.toThrow('CODEX_ALLOWANCE_UNAVAILABLE');
  await assertClosed();
});

test('deadline drains uncancellable preparation and never spawns after it expires', async () => {
  syntheticLogin();
  const start = jest.mocked(ownedTransport.startOwnedCodexAppServer);
  let release!: () => void;
  const preparing = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(prepareCodexRuntimeEnvironment).mockImplementation(async () => { await preparing; return options().runtime; });
  const pending = expect(collectCodexAllowance({ timeoutMs: 10 })).rejects.toThrow('CODEX_ALLOWANCE_UNAVAILABLE');
  await new Promise(resolve => setTimeout(resolve, 25));
  release(); await pending;
  expect(start).not.toHaveBeenCalled();
});
