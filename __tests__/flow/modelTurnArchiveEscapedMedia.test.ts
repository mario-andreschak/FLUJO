import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Each process owns its ALS/ledger: the intentional failed-close quarantine
// must remain charged permanently without poisoning another test's admission.
it.each(['released', 'quarantined', 'open-await', 'open-failure-await', 'close-failure-await', 'stat-await', 'read-await'])('rejects escaped media I/O after %s scope settlement', mode => {
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const Module = require('node:module');
    const ts = require('typescript');
    const root = process.cwd();
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function(name, ...args) {
      if (name.startsWith('@/')) name = path.join(root, 'src', name.slice(2));
      return resolve.call(this, name, ...args);
    };
    Module._extensions['.ts'] = function(module, filename) {
      module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, filename);
    };
    const budget = require('./src/backend/execution/flow/modelTurnArchiveWriteBudget.ts');
    const mode = process.argv[1];
    let open = 0, stat = 0, read = 0, close = 0;
    let release, entered;
    const gate = new Promise(done => release = done);
    const reached = new Promise(done => entered = done);
    const handle = {
      stat: async () => { stat++; if (mode === 'stat-await') { entered(); await gate; } return { isFile: () => true, size: 1 }; },
      read: async buffer => { read++; if (mode === 'read-await') { entered(); await gate; } buffer[0] = 65; return { bytesRead: 1 }; },
      close: async () => { close++; if (mode === 'close-failure-await') throw new Error('close uncertain'); }
    };
    fs.promises.open = async () => {
      open++;
      if (['open-await', 'open-failure-await', 'close-failure-await'].includes(mode)) {
        entered(); await gate;
        if (mode === 'open-failure-await') throw new Error('open failed');
      }
      return handle;
    };
    (async () => {
      let escaped, observed;
      await budget.withArchiveWriteMemory('history', async () => {
        if (mode.endsWith('-await')) {
          observed = budget.readArchiveLocalMedia('fixture').then(() => ({ ok: true }), error => ({ error }));
          await reached;
        } else {
          escaped = gate.then(() => budget.readArchiveLocalMedia('fixture'));
          observed = escaped.then(() => ({ ok: true }), error => ({ error }));
        }
        if (mode === 'quarantined') {
          await assert.rejects(budget.closeArchiveWriteHandle({ close: async () => { throw new Error('uncertain close'); } }),
            { code: 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' });
        }
      }, 'owned-only');
      const before = budget.getArchiveWritePressure();
      assert.equal(before.writers, mode === 'quarantined' || mode.endsWith('-await') ? 1 : 0);
      if (mode === 'quarantined' || mode.endsWith('-await')) assert.ok(before.bytes > 0);
      release();
      const result = await observed;
      if (mode === 'open-failure-await') assert.equal(result.error?.message, 'open failed');
      else assert.equal(result.error?.code, mode === 'close-failure-await' ? 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' : 'MODEL_TURN_ARCHIVE_MEMORY_BUSY');
      assert.equal(open, mode.endsWith('-await') ? 1 : 0);
      assert.equal(stat, ['stat-await', 'read-await'].includes(mode) ? 1 : 0);
      assert.equal(read, mode === 'read-await' ? 1 : 0);
      assert.equal(close, mode.endsWith('-await') && mode !== 'open-failure-await' ? 1 : 0);
      const after = budget.getArchiveWritePressure();
      const quarantined = ['quarantined', 'close-failure-await'].includes(mode);
      assert.equal(after.bytes, quarantined ? before.bytes : 0);
      assert.equal(after.writers, quarantined ? 1 : 0);
      assert.equal(after.quarantined, quarantined ? 1 : 0);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script, mode], {
    cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
