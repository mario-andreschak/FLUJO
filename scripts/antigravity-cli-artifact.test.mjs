import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../bin/antigravity-runtime.cjs', import.meta.url), 'utf8');
function runtime({ present = true, version = '1.4.2', failInstall = false, help = true } = {}) {
  let installed = present;
  const calls = [];
  const execFile = () => {};
  execFile[promisify.custom] = async (file, args, options) => {
    calls.push({ file, args, options });
    if (file.endsWith('powershell.exe')) {
      if (failInstall) throw new Error('secret installer output');
      installed = true;
    }
    return { stdout: args.includes('--version') ? version : '', stderr: help ? '--input-format --output-format --agent --disable-slash-commands --print-timeout' : '' };
  };
  const fakeRequire = name => name === 'node:child_process' ? { execFile }
    : name === 'node:path' ? path.win32
      : name === 'node:os' ? { homedir: () => 'C:\\Users\\Owner' }
        : name === 'node:fs' ? { statSync: file => {
          if (!installed || file !== 'C:\\Users\\Owner\\AppData\\Local\\agy\\bin\\agy.exe') throw new Error('ENOENT');
          return { isFile: () => true, ino: 1n, size: 42n, mtimeNs: 1n, ctimeNs: 1n };
        } } : require(name);
  const nativeModule = { exports: {} };
  vm.runInNewContext(`(function(require,module,process){${source}\n})`)(fakeRequire, nativeModule, {
    platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local', PATH: '.;relative;C:\\Tools', SystemRoot: 'C:\\Windows' },
  });
  return { native: nativeModule.exports, calls };
}

test('production package ships direct official CLI support without a wrapper or install hook', () => {
  const application = require('../package.json');
  assert.equal(application.dependencies['@flujo-ai/antigravity-cli'], undefined);
  assert.equal(application.bin['flujo-agy'], undefined);
  assert.equal(application.scripts.postinstall, undefined);
  assert.ok(!application.workspaces.includes('packages/antigravity-cli'));
});

test('release pre-flight launches the installed official CLI with the required protocol', { timeout: 300000 }, async () => {
  const native = require('../bin/antigravity-runtime.cjs');
  const executable = await native.resolveBinary();
  assert.ok(path.isAbsolute(executable));
  assert.ok(!executable.includes('packages' + path.sep + 'antigravity-cli'));
});

test('detects a newly installed Windows CLI without PATH refresh and checks its protocol flags', async () => {
  const { native, calls } = runtime();
  assert.equal(await native.resolveBinary(), 'C:\\Users\\Owner\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes('--disable-slash-commands'));
  assert.ok(calls.every(call => call.options.windowsHide));
  assert.ok(!native.candidates().some(file => file.startsWith('relative') || file === 'agy.exe'));
  await native.resolveBinary();
  assert.equal(calls.length, 2, 'unchanged executable reuses compatibility result');
});

test('missing installations share one vendor install and concurrent callers resolve the official binary', async () => {
  const { native, calls } = runtime({ present: false });
  const paths = await Promise.all([native.resolveBinary(), native.resolveBinary()]);
  assert.equal(paths[0], paths[1]);
  const installs = calls.filter(call => call.file.endsWith('powershell.exe'));
  assert.equal(installs.length, 1);
  assert.ok(installs[0].args.at(-1).includes('https://antigravity.google/cli/install.ps1'));
});

test('installer failures are sanitized and retryable; incompatible CLIs are never used', async () => {
  const { native, calls } = runtime({ present: false, failInstall: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(native.resolveBinary(), error => /Could not install/.test(error.message) && !error.message.includes('secret'));
  }
  assert.equal(calls.length, 2);
  await assert.rejects(runtime({ version: '1.2.13' }).native.resolveBinary(), /Update the official/);
  await assert.rejects(runtime({ version: '2.0.0' }).native.resolveBinary(), /Update the official/);
  await assert.rejects(runtime({ help: false }).native.resolveBinary(), /required FLUJO integration/);
});
