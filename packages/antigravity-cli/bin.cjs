#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { resolveBinary } = require('./index.cjs');
const child = spawn(resolveBinary(), process.argv.slice(2), {
  stdio: 'inherit', shell: false, windowsHide: true,
  env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
