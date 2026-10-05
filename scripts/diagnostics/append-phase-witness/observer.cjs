'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// Aggregate observations: no event values or task arguments are serialized.
// Native failure messages may include the runner-owned synthetic filesystem path.
// All calls delegate to original functions. Additional timing continuations,
// function/task wrappers, checkpoint scans and FileHandle own methods add cost.
function createObserver(progressFile) {
  if (!progressFile || fs.existsSync(progressFile)) throw new Error('Fresh explicit progress file required');
  const rawAppend = fs.appendFileSync.bind(fs);
  const rawOpenDirectory = fs.opendirSync.bind(fs);
  const started = performance.now();
  const active = new Map();
  const totals = new Map();
  const failures = [];
  const observerErrors = [];
  const handles = new Map();
  let nextId = 0;
  let lockRoot;
  let eventRoot;
  let replacements = [];
  let observationOverflow = false;
  let checkpoints = 0;
  const work = { logicalFsCalls: 0, successfulReadBytes: 0, proposedWriteBytes: 0, parseCalls: 0, parseInputUtf8Bytes: 0 };
  const limits = { logicalFsCalls: 100_000, successfulReadBytes: 8 * 1024 * 1024, parseInputUtf8Bytes: 8 * 1024 * 1024 };
  const byteLength = value => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : ArrayBuffer.isView(value) ? value.byteLength : 0;
  function assertWorkBudget() {
    if (observationOverflow || observerErrors.length || Object.keys(limits).some(key => work[key] > limits[key])) throw new Error('Diagnostic observation/work budget exceeded; partial progress retained');
  }
  const round = value => Math.round(value * 1000) / 1000;
  function observationError(error) {
    observationOverflow = true;
    if (observerErrors.length < 16) observerErrors.push({ name: error?.name, message: String(error?.message ?? error).slice(0, 500) });
  }
  function category(value) {
    const input = typeof value === 'string' ? value : value instanceof URL ? value.pathname : '';
    if (!input) return 'fd-or-unknown';
    if (input.startsWith('/proc/')) return 'process-identity';
    const normalized = path.resolve(input);
    if (lockRoot && (normalized === lockRoot || normalized.startsWith(lockRoot + path.sep))) {
      const name = path.basename(normalized);
      const owner = name.includes('.workspace-capture-admission') ? 'admission' : name.includes('.workspace-capture-writer-') ? 'writer' : 'domain';
      const kind = name.includes('.candidate.') ? 'candidate' : name.includes('.abandoned.') ? 'abandoned' : name.includes('.recovery.') ? 'recovery' : name.endsWith('.lock') ? 'canonical' : 'root';
      return `lock:${owner}:${kind}`;
    }
    if (eventRoot && (normalized === eventRoot || normalized.startsWith(eventRoot + path.sep))) return 'event-log';
    return 'workspace-or-other';
  }
  function begin(name, args = [], parent) {
    const label = name === 'acquireFilesystemLock' ? `${name}:${String(args[0]).startsWith('.workspace-capture-admission') ? 'admission' : String(args[0]).startsWith('.workspace-capture-writer-') ? 'writer' : 'domain'}` : name;
    const token = { id: ++nextId, label, began: performance.now(), parentId: parent?.id, waitedMs: parent ? performance.now() - parent.began : undefined, done: false };
    if (name === 'parseLogLine') { token.inputBytes = byteLength(args[0]); work.parseCalls++; work.parseInputUtf8Bytes += token.inputBytes; }
    if (active.size < 2048) active.set(token.id, token); else observationOverflow = true;
    return token;
  }
  function finish(token, error) {
    if (!token || token.done) return;
    token.done = true;
    active.delete(token.id);
    if (!totals.has(token.label) && totals.size >= 512) { observationOverflow = true; return; }
    const total = totals.get(token.label) ?? { calls: 0, failures: 0, totalMs: 0, maxMs: 0, taskWaitTotalMs: 0, taskWaitMaxMs: 0, successfulReadBytes: 0, proposedWriteBytes: 0, parseInputUtf8Bytes: 0 };
    const elapsed = performance.now() - token.began;
    total.calls++; total.totalMs += elapsed; total.maxMs = Math.max(total.maxMs, elapsed);
    total.successfulReadBytes += token.readBytes ?? 0; total.proposedWriteBytes += token.writeBytes ?? 0; total.parseInputUtf8Bytes += token.inputBytes ?? 0;
    if (token.waitedMs !== undefined) { total.taskWaitTotalMs += token.waitedMs; total.taskWaitMaxMs = Math.max(total.taskWaitMaxMs, token.waitedMs); }
    if (error) {
      total.failures++;
      if (failures.length < 16) failures.push({ phase: token.label, name: error?.name, code: error?.code, message: String(error?.message ?? error).slice(0, 500) });
    }
    totals.set(token.label, total);
  }
  function ended(token, value) {
    if (value && typeof value.then === 'function') {
      // Observe settlement while returning the original value/promise unchanged.
      value.then(() => finish(token), error => finish(token, error));
    } else finish(token);
  }
  function wrapTask(parent, original) {
    if (typeof original !== 'function') throw new Error('Expected task function in exact pinned source');
    return function (...args) {
      const token = begin(parent.label + ':task', [], parent);
      try { const value = Reflect.apply(original, this, args); ended(token, value); return value; }
      catch (error) { finish(token, error); throw error; }
    };
  }
  function replace(target, name, classification, after) {
    const original = target[name];
    if (typeof original !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const wrapper = function (...args) {
      const token = begin(`fs:${name}:${classification ?? category(args[0])}`);
      work.logicalFsCalls++;
      if (/^(writeFile|appendFile)(Sync)?$/.test(name)) { token.writeBytes = byteLength(classification ? args[0] : args[1]); work.proposedWriteBytes += token.writeBytes; }
      const completed = result => {
        token.readBytes = /^readFile(Sync)?$/.test(name) ? byteLength(result) : name === 'read' && Number.isSafeInteger(result?.bytesRead) ? result.bytesRead : 0;
        work.successfulReadBytes += token.readBytes;
        finish(token); if (after) try { after(result); } catch (error) { observationError(error); }
      };
      try {
        const value = Reflect.apply(original, this, args);
        if (value && typeof value.then === 'function') value.then(completed, error => finish(token, error));
        else completed(value);
        return value;
      } catch (error) { finish(token, error); throw error; }
    };
    // Preserve helpers such as realpathSync.native and custom promisify symbols.
    // Those direct helper calls remain outside the logical-call observation.
    for (const key of Reflect.ownKeys(original)) if (!['name', 'length', 'prototype', 'arguments', 'caller'].includes(key)) Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(original, key));
    Object.defineProperty(target, name, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: wrapper });
    const restore = () => descriptor ? Object.defineProperty(target, name, descriptor) : delete target[name];
    return restore;
  }
  function observeHandle(handle, classification) {
    if (!handle || handles.has(handle)) return;
    if (handles.size >= 128) { observationOverflow = true; return; }
    const restores = [];
    handles.set(handle, restores);
    for (const name of ['read', 'readFile', 'write', 'writeFile', 'appendFile', 'stat', 'sync', 'datasync', 'truncate', 'close']) {
      const restore = replace(handle, name, classification, name === 'close' ? () => {
        for (const restoreMethod of restores.reverse()) restoreMethod();
        handles.delete(handle);
      } : undefined);
      if (restore) restores.push(restore);
    }
  }
  function installFilesystemObservation(root, logs) {
    if (replacements.length) throw new Error('Filesystem observation already installed');
    lockRoot = path.resolve(root); eventRoot = path.resolve(logs);
    for (const name of ['lstat', 'stat', 'realpath', 'readdir', 'readFile', 'writeFile', 'appendFile', 'mkdir', 'link', 'unlink', 'rename', 'rm', 'access']) {
      const restore = replace(fs.promises, name); if (restore) replacements.push(restore);
    }
    for (const name of ['lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'linkSync', 'unlinkSync', 'renameSync', 'rmSync', 'existsSync']) {
      const restore = replace(fs, name); if (restore) replacements.push(restore);
    }
    const original = fs.promises.open;
    const descriptor = Object.getOwnPropertyDescriptor(fs.promises, 'open');
    fs.promises.open = function (...args) {
      const token = begin('fs:open:' + category(args[0]));
      work.logicalFsCalls++;
      try {
        const result = Reflect.apply(original, this, args);
        result.then(handle => { finish(token); try { observeHandle(handle, category(args[0])); } catch (error) { observationError(error); } }, error => finish(token, error));
        return result;
      } catch (error) { finish(token, error); throw error; }
    };
    replacements.push(() => Object.defineProperty(fs.promises, 'open', descriptor));
  }
  function restoreFilesystemObservation() {
    for (const restore of replacements.reverse()) restore();
    replacements = [];
    for (const restores of handles.values()) for (const restore of restores.reverse()) restore();
    handles.clear();
  }
  function cardinalities() {
    const counts = { total: 0, canonical: 0, candidate: 0, recovery: 0, abandoned: 0, other: 0, truncated: false };
    let directory;
    try {
      directory = rawOpenDirectory(lockRoot);
      let entry;
      while ((entry = directory.readSync())) {
        if (counts.total === 4096) { counts.truncated = true; observationOverflow = true; break; }
        counts.total++;
        const name = entry.name;
        const kind = name.includes('.candidate.') ? 'candidate' : name.includes('.abandoned.') ? 'abandoned' : name.includes('.recovery.') ? 'recovery' : name.endsWith('.lock') ? 'canonical' : 'other';
        counts[kind]++;
      }
    } catch (error) { counts.errorCode = error.code; }
    finally { directory?.closeSync(); }
    return counts;
  }
  function checkpoint(progress) {
    const snapshotStarted = performance.now();
    const gates = [...(globalThis.__flujoWorkspaceMutationGates?.values() ?? [])];
    const snapshot = {
      schemaVersion: 1, utc: new Date().toISOString(), elapsedMs: round(snapshotStarted - started), checkpoint: ++checkpoints, ...progress,
      instrumentation: 'load-time-source-observation; delegated filesystem calls; overhead-present',
      inflight: [...active.values()].map(token => ({ id: token.id, parentId: token.parentId, phase: token.label, elapsedMs: round(snapshotStarted - token.began) })),
      aggregates: Object.fromEntries([...totals].map(([key, value]) => [key, Object.fromEntries(Object.entries(value).map(([field, number]) => [field, round(number)]))])),
      lockFiles: cardinalities(),
      globalCounts: { activeOwners: globalThis.__flujo_enduring_agent_active_lock_owners?.size ?? 0, deferredCleanupKeys: globalThis.__flujo_enduring_agent_deferred_lock_cleanups?.size ?? 0, writerAdmissionChains: globalThis.__flujo_workspace_writer_admission_chains?.size ?? 0, workspaceGates: gates.length, activeMutations: gates.reduce((sum, gate) => sum + gate.activeMutations, 0), admissionWaiters: gates.reduce((sum, gate) => sum + gate.admissionWaiters.size, 0), drainWaiters: gates.reduce((sum, gate) => sum + gate.drainWaiters.size, 0) },
      failures,
      observerErrors,
      work: { ...work }, workLimits: limits,
    };
    snapshot.observationOverflow = observationOverflow;
    snapshot.observerScanMs = round(performance.now() - snapshotStarted);
    rawAppend(progressFile, JSON.stringify(snapshot) + '\n', { mode: 0o600 });
  }
  return { begin, ended, failed: finish, wrapTask, checkpoint, installFilesystemObservation, restoreFilesystemObservation, assertWorkBudget };
}
module.exports = { createObserver };
