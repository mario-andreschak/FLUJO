/**
 * Measures a FLUJO server from inside, without any change to FLUJO.
 *
 *   NODE_OPTIONS="--require scripts/load-test/server-probe.cjs" FLUJO_LOAD_PROBE_FILE=probe.jsonl
 *
 * Once a second it adds one line to the file: memory, event-loop delay, open handles,
 * and how much was written to disk, grouped by folder. Writes are counted at the file
 * functions, which also shows how often whole files get replaced. Only sizes and folder
 * names are recorded, never content. The fixed part of each path is kept and every part
 * that looks like an id becomes `*`.
 *
 * Child processes inherit NODE_OPTIONS, so anything other than the Next server stays
 * unmeasured.
 */
'use strict';

const file = process.env.FLUJO_LOAD_PROBE_FILE;
const isNextServer = process.argv.some((argument) => /next[\\/]dist[\\/]bin[\\/]next/.test(argument));

if (file && isNextServer) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { monitorEventLoopDelay } = require('node:perf_hooks');

  const root = path.resolve(process.env.FLUJO_DATA_DIR || '.');
  const counters = new Map();
  const totals = { writes: 0, bytes: 0, renames: 0, syncs: 0, unlinks: 0, reads: 0, readBytes: 0 };

  const ID = /^(?:[0-9a-f]{8}-[0-9a-f-]{27}|load-[A-Za-z0-9_-]+|[0-9a-f]{16,}|.*\.tmp.*|\d{6,})$/i;
  const groupOf = (target) => {
    if (typeof target !== 'string' && !(target instanceof URL)) return 'other';
    let relative;
    try { relative = path.relative(root, String(target)); } catch { return 'other'; }
    if (relative.startsWith('..')) return 'outside-data-dir';
    const parts = relative.split(path.sep).filter(Boolean);
    const leaf = parts.pop() ?? '';
    const shape = leaf.includes('.') ? `*${path.extname(leaf.replace(/\.tmp.*$/, ''))}` : '*';
    return [...parts.map((part) => (ID.test(part) ? '*' : part)).slice(0, 6), shape].join('/');
  };
  const count = (target, field, amount = 1) => {
    const group = groupOf(target);
    let entry = counters.get(group);
    if (!entry) {
      entry = { writes: 0, bytes: 0, renames: 0, syncs: 0, unlinks: 0, reads: 0, readBytes: 0 };
      counters.set(group, entry);
    }
    entry[field] += amount;
    totals[field] += amount;
  };
  const sizeOf = (data) => (typeof data === 'string' ? Buffer.byteLength(data)
    : ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0);

  const handlePaths = new WeakMap();
  const promises = fs.promises;
  const wrap = (owner, name, wrapper) => {
    const original = owner[name];
    if (typeof original === 'function') owner[name] = wrapper(original);
  };
  wrap(promises, 'open', (original) => async function open(target, ...rest) {
    const handle = await original.call(this, target, ...rest);
    handlePaths.set(handle, target);
    return handle;
  });
  wrap(promises, 'writeFile', (original) => function writeFile(target, data, ...rest) {
    count(target, 'writes'); count(target, 'bytes', sizeOf(data));
    return original.call(this, target, data, ...rest);
  });
  wrap(promises, 'appendFile', (original) => function appendFile(target, data, ...rest) {
    count(target, 'writes'); count(target, 'bytes', sizeOf(data));
    return original.call(this, target, data, ...rest);
  });
  wrap(promises, 'rename', (original) => function rename(from, to) {
    count(to, 'renames');
    return original.call(this, from, to);
  });
  wrap(promises, 'unlink', (original) => function unlink(target) {
    count(target, 'unlinks');
    return original.call(this, target);
  });
  wrap(promises, 'readFile', (original) => async function readFile(target, ...rest) {
    const result = await original.call(this, target, ...rest);
    count(target, 'reads'); count(target, 'readBytes', sizeOf(result));
    return result;
  });
  for (const name of ['writeFileSync', 'appendFileSync']) {
    wrap(fs, name, (original) => function writeSync(target, data, ...rest) {
      count(target, 'writes'); count(target, 'bytes', sizeOf(data));
      return original.call(this, target, data, ...rest);
    });
  }
  wrap(fs, 'renameSync', (original) => function renameSync(from, to) {
    count(to, 'renames');
    return original.call(this, from, to);
  });
  wrap(fs, 'readFileSync', (original) => function readFileSync(target, ...rest) {
    const result = original.call(this, target, ...rest);
    if (typeof target === 'string' && !target.includes('node_modules') && !target.includes('.next')) {
      count(target, 'reads'); count(target, 'readBytes', sizeOf(result));
    }
    return result;
  });

  // FileHandle methods live on an internal class, reachable through any open handle.
  const patchHandles = async () => {
    const handle = await promises.open(__filename, 'r');
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    wrap(prototype, 'writeFile', (original) => function writeFile(data, ...rest) {
      const target = handlePaths.get(this);
      count(target, 'writes'); count(target, 'bytes', sizeOf(data));
      return original.call(this, data, ...rest);
    });
    wrap(prototype, 'appendFile', (original) => function appendFile(data, ...rest) {
      const target = handlePaths.get(this);
      count(target, 'writes'); count(target, 'bytes', sizeOf(data));
      return original.call(this, data, ...rest);
    });
    wrap(prototype, 'write', (original) => function write(data, ...rest) {
      const target = handlePaths.get(this);
      count(target, 'writes'); count(target, 'bytes', sizeOf(data));
      return original.call(this, data, ...rest);
    });
    for (const name of ['sync', 'datasync']) {
      wrap(prototype, name, (original) => function syncFile(...rest) {
        count(handlePaths.get(this), 'syncs');
        return original.apply(this, rest);
      });
    }
  };
  patchHandles().catch(() => undefined);

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = Date.now();
  const stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => undefined);

  const sample = () => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const toMs = (nanoseconds) => Math.round(nanoseconds / 1e4) / 100;
    const resources = {};
    for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
    const line = {
      t: Date.now(),
      uptimeS: Math.round((Date.now() - started) / 1000),
      pid: process.pid,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      delayP50Ms: toMs(delay.percentile(50)),
      delayP99Ms: toMs(delay.percentile(99)),
      delayMaxMs: toMs(delay.max),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      resources,
      disk: { ...totals },
      diskByGroup: Object.fromEntries(counters),
    };
    delay.reset();
    stream.write(`${JSON.stringify(line)}\n`);
  };
  const timer = setInterval(sample, 1000);
  timer.unref();
  process.once('exit', () => { try { clearInterval(timer); } catch { /* exiting */ } });
}
