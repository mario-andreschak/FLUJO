#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { resolveBinary } = require('./index.cjs');
const { parseNativeModels } = require('./models.cjs');
const args = process.argv.slice(2);
const jsonModels = args.length === 3 && args[0] === 'models' && args[1] === '--output-format' && args[2] === 'json';
const child = spawn(resolveBinary(), jsonModels ? ['models'] : args, {
  stdio: jsonModels ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
});
let output = '';
let failed = false;
const deadline = jsonModels ? setTimeout(() => { failed = true; child.kill(); }, 15000) : undefined;
deadline?.unref();
if (jsonModels) {
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (failed) return;
    output += String(chunk);
    if (Buffer.byteLength(output) > 1024 * 1024) { failed = true; child.kill(); }
  });
  // Native errors may contain authentication details. The wrapper reports only
  // a fixed failure; the trusted host owns recovery/authentication diagnostics.
  child.stderr.on('data', () => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { failed = true; });
child.on('close', code => {
  if (deadline) clearTimeout(deadline);
  if (!jsonModels) { process.exitCode = code ?? 1; return; }
  try {
    if (failed || code !== 0) throw new Error('Antigravity model discovery failed. Check the connection authentication and runtime.');
    process.stdout.write(JSON.stringify({ models: parseNativeModels(output), entitlementVerified: false }) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
});
