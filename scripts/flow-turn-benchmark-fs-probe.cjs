/**
 * Diagnostic preload for scripts/flow-turn-benchmark.mjs (--fs-probe).
 * Loaded with `node --require` into the FLUJO server under test only. It counts
 * file-system calls and the wall time each one takes, and every 100 ms writes
 * the running totals to FLUJO_BENCH_FS_STATS.<pid>.json so the benchmark can
 * take the difference around one turn. It never changes arguments or results.
 */
'use strict';
const fs = require('node:fs');
const out = process.env.FLUJO_BENCH_FS_STATS;
if (out) {
  const { performance } = require('node:perf_hooks');
  const writeStats = fs.writeFileSync; // captured before wrapping: the probe's own writes are not counted
  const stats = Object.create(null);
  const sites = Object.create(null);
  const callSite = () => String(new Error().stack).split('\n').slice(3)
    .filter(line => !line.includes('node:internal') && !line.includes('flow-turn-benchmark-fs-probe'))
    .slice(0, 3).map(line => line.trim().replace(/^at /, '').replace(/\(.*[\\/](\.next|node_modules)[\\/]/, '($1/')).join(' < ');
  const record = (name, started, site) => {
    const elapsed = performance.now() - started;
    const entry = stats[name] ??= { count: 0, ms: 0 };
    entry.count++; entry.ms += elapsed;
    const bucket = sites[`${name} @ ${site}`] ??= { count: 0, ms: 0 };
    bucket.count++; bucket.ms += elapsed;
  };
  let handleWrapped = false;
  const wrapHandle = handle => {
    if (handleWrapped || !handle) return;
    handleWrapped = true;
    const proto = Object.getPrototypeOf(handle);
    for (const key of ['sync', 'datasync', 'write', 'writeFile', 'read', 'readFile', 'close', 'stat', 'appendFile', 'truncate']) {
      wrapAsync(proto, key, `handle.${key}`);
    }
  };
  function wrapAsync(target, key, name) {
    const original = target[key];
    if (typeof original !== 'function') return;
    target[key] = function probed(...args) {
      const started = performance.now();
      const site = callSite();
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then(value => {
          record(name, started, site);
          if (name === 'promises.open') wrapHandle(value);
          return value;
        }, error => { record(name, started, site); throw error; });
      }
      record(name, started, site);
      return result;
    };
  }
  const wrapSync = (target, key, name) => {
    const original = target[key];
    if (typeof original !== 'function') return;
    target[key] = function probed(...args) {
      const started = performance.now();
      try { return original.apply(this, args); } finally { record(name, started, callSite()); }
    };
  };
  const wrapCallback = (target, key, name) => {
    const original = target[key];
    if (typeof original !== 'function') return;
    target[key] = function probed(...args) {
      const started = performance.now();
      const site = callSite();
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = function done(...results) { record(name, started, site); return callback.apply(this, results); };
      }
      return original.apply(this, args);
    };
  };
  for (const key of ['open', 'writeFile', 'readFile', 'rename', 'mkdir', 'stat', 'lstat', 'readdir', 'unlink', 'appendFile',
    'realpath', 'rm', 'copyFile', 'access', 'opendir', 'link', 'utimes', 'chmod']) wrapAsync(fs.promises, key, `promises.${key}`);
  for (const key of ['fsyncSync', 'fdatasyncSync', 'writeFileSync', 'readFileSync', 'openSync', 'renameSync', 'lstatSync', 'statSync',
    'realpathSync', 'readdirSync', 'existsSync', 'mkdirSync', 'writeSync', 'readSync', 'closeSync', 'fstatSync', 'unlinkSync',
    'appendFileSync', 'rmSync', 'copyFileSync', 'accessSync']) wrapSync(fs, key, key);
  for (const key of ['fsync', 'fdatasync', 'open', 'close', 'write', 'writeFile', 'rename', 'stat', 'lstat', 'readFile', 'mkdir', 'unlink', 'realpath']) {
    wrapCallback(fs, key, key);
  }
  const target = `${out}.${process.pid}.json`;
  let last = '';
  setInterval(() => {
    const text = JSON.stringify({ pid: process.pid, stats, sites });
    if (text === last) return;
    last = text;
    try { writeStats(target, text); } catch { /* best effort */ }
  }, 100).unref();
}
