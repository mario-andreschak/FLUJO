/**
 * The worker thread that runs one code-mode program (#1448).
 *
 * It is plain CommonJS kept as text, because a worker needs a script file or
 * source at run time and the app bundle has no stable path for a `.js` file.
 * The program itself runs inside QuickJS compiled to WebAssembly: it has no
 * `require`, `process`, network, file system or timers. Its only way out is
 * `__flujoCall`, which posts a message to the parent; the parent checks and
 * runs the tool and posts the answer back.
 *
 * Messages:
 *   worker -> parent  { type: 'call', id, name, args }   args is JSON text
 *   parent -> worker  { type: 'result', id, ok, value?, error? }   value is JSON text
 *   worker -> parent  { type: 'done', ok, result?, error?, logs, logsTrimmed }
 */
export const SANDBOX_WORKER_SOURCE = String.raw`'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const core = require(workerData.corePath);
const variantModule = require(workerData.variantPath);
const variant = variantModule.default || variantModule;

const logs = [];
let logChars = 0;
let logsTrimmed = false;
let finished = false;

function addLog(text) {
  if (logChars >= workerData.maxLogChars) { logsTrimmed = true; return; }
  const room = workerData.maxLogChars - logChars;
  const piece = text.length > room ? text.slice(0, room) : text;
  if (piece.length < text.length) logsTrimmed = true;
  logs.push(piece);
  logChars += piece.length + 1;
}

function finish(message) {
  if (finished) return;
  finished = true;
  message.type = 'done';
  message.logs = logs.join('\n');
  message.logsTrimmed = logsTrimmed;
  parentPort.postMessage(message);
}

function describe(value) {
  if (value && typeof value === 'object') {
    const name = typeof value.name === 'string' ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : JSON.stringify(value);
    return name + ': ' + message;
  }
  return String(value);
}

function textOf(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}

(async () => {
  const QuickJS = await core.newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(workerData.memoryBytes);
  runtime.setMaxStackSize(workerData.stackBytes);
  let sliceStart = Date.now();
  runtime.setInterruptHandler(() => Date.now() - sliceStart > workerData.sliceMs);
  const vm = runtime.newContext();
  const pending = new Map();
  let nextId = 0;

  const failWith = (handle) => {
    const error = vm.dump(handle);
    handle.dispose();
    finish({ ok: false, error: describe(error) });
  };
  const pump = () => {
    sliceStart = Date.now();
    const jobs = runtime.executePendingJobs();
    if (jobs.error) failWith(jobs.error);
  };

  const consoleObject = vm.newObject();
  const logFn = vm.newFunction('log', (...args) => {
    addLog(args.map((arg) => textOf(vm.dump(arg))).join(' '));
  });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) vm.setProp(consoleObject, level, logFn);
  vm.setProp(vm.global, 'console', consoleObject);
  logFn.dispose();
  consoleObject.dispose();

  const callFn = vm.newFunction('__flujoCall', (nameHandle, argsHandle) => {
    const id = ++nextId;
    const deferred = vm.newPromise();
    pending.set(id, deferred);
    parentPort.postMessage({ type: 'call', id, name: vm.getString(nameHandle), args: vm.getString(argsHandle) });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__flujoCall', callFn);
  callFn.dispose();

  parentPort.on('message', (message) => {
    if (!message || message.type !== 'result' || finished) return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    const reply = vm.newString(JSON.stringify({ ok: message.ok === true, value: message.value, error: message.error }));
    deferred.resolve(reply);
    reply.dispose();
    deferred.dispose();
    pump();
  });

  const prelude = [
    'globalThis.callTool = async function callTool(name, args) {',
    '  const reply = JSON.parse(await __flujoCall(String(name), JSON.stringify(args === undefined ? {} : args)));',
    '  if (!reply.ok) throw new Error(reply.error);',
    '  return reply.value === undefined ? undefined : JSON.parse(reply.value);',
    '};',
    'globalThis.tools = {};',
    'for (const b of JSON.parse(' + JSON.stringify(JSON.stringify(workerData.bindings)) + ')) {',
    '  if (!tools[b.namespace]) tools[b.namespace] = {};',
    '  tools[b.namespace][b.fn] = (args) => callTool(b.name, args);',
    '}',
  ].join('\n');
  const preludeResult = vm.evalCode(prelude, 'flujo-prelude.js');
  if (preludeResult.error) { failWith(preludeResult.error); return; }
  preludeResult.value.dispose();

  sliceStart = Date.now();
  const program = '(async () => { const __flujoResult = await (async () => {\n' + workerData.code +
    '\n})(); return __flujoResult === undefined ? "null" : JSON.stringify(__flujoResult); })()';
  const evaluated = vm.evalCode(program, 'program.js');
  if (evaluated.error) { failWith(evaluated.error); return; }
  vm.resolvePromise(evaluated.value).then((settled) => {
    if (settled.error) { failWith(settled.error); return; }
    const text = vm.getString(settled.value);
    settled.value.dispose();
    finish({ ok: true, result: text });
  });
  pump();
})().catch((error) => finish({ ok: false, error: describe(error) }));
`;
