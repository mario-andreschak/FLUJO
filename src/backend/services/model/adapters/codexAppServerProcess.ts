import { spawn } from 'node:child_process';
import { captureRuntimeChildIdentity, type RuntimeProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';

export interface CodexOwnedProcessRegistration {
  readonly identity: Readonly<RuntimeProcessIdentity>;
  requestStop(): void;
  readonly exit: Promise<Readonly<{code: number | null; signal: NodeJS.Signals | null}>>;
  readonly close: Promise<void>;
}

const registrationRoot = globalThis as typeof globalThis & { __flujoCodexOwnedRegistrations?: WeakMap<object, object> };
const registrations = registrationRoot.__flujoCodexOwnedRegistrations ??= new WeakMap<object, object>();
export function assertCodexOwnedProcessRegistration(value: unknown, owner: object): asserts value is CodexOwnedProcessRegistration {
  if (!value || typeof value !== 'object' || registrations.get(value) !== owner) {
    throw new Error('Owned Codex process registration is unavailable or mismatched.');
  }
}

type Message = {id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown};
type Pending = {resolve(value: unknown): void; reject(error: unknown): void; timer: NodeJS.Timeout};
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 32;
const METHODS = new Set(['initialize', 'model/list', 'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/interrupt']);

/** Own the public app-server child at birth. Registration precedes all wire input.
 * This transport does not by itself qualify a model, tool inventory, or Original.
 */
export async function startOwnedCodexAppServer(input: {
  executable: string; args?: string[]; env: NodeJS.ProcessEnv; cwd: string; owner: object;
  register(process: CodexOwnedProcessRegistration): Promise<void>;
  signal?: AbortSignal; onNotification(message: Readonly<Message>): void;
  admissionTimeoutMs?: number;
}) {
  input.signal?.throwIfAborted();
  const admissionTimeoutMs=input.admissionTimeoutMs ?? 30000;
  if(!Number.isInteger(admissionTimeoutMs) || admissionTimeoutMs<1 || admissionTimeoutMs>30000)throw new Error('Invalid Codex admission timeout.');
  const child = spawn(input.executable, input.args ?? ['app-server', '--stdio'], {
    env: input.env, cwd: input.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let exited = false, closed = false, stopping = false, registered = false, sequence = 0;
  let frame = Buffer.alloc(0);
  const pending = new Map<number, Pending>();
  const unavailable = () => new Error('Owned Codex app-server transport is unavailable.');
  const rejectPending = (error: unknown) => {
    for (const entry of pending.values()) {clearTimeout(entry.timer);entry.reject(error);}
    pending.clear();
  };
  const exit = new Promise<Readonly<{code: number | null; signal: NodeJS.Signals | null}>>(resolve => {
    child.once('exit', (code, signal) => {exited=true;resolve(Object.freeze({code,signal}));});
  });
  const close = new Promise<void>(resolve => child.once('close', () => {
    closed=true;rejectPending(unavailable());input.signal?.removeEventListener('abort', abort);resolve();
  }));
  const requestStop = () => {
    stopping=true;
    if (!exited && !closed) child.kill();
  };
  const abort = () => {rejectPending(unavailable());requestStop();};
  input.signal?.addEventListener('abort',abort,{once:true});
  if (input.signal?.aborted) abort();
  child.on('error', error => {rejectPending(error);requestStop();});
  child.stdin.on('error', error => {rejectPending(error);requestStop();});
  // Drain diagnostics without forwarding auth, arguments or unbounded output.
  child.stderr.on('data', () => {});
  const write = (message: Message) => {
    if (!registered || exited || closed || stopping || input.signal?.aborted) throw unavailable();
    const bytes = Buffer.from(JSON.stringify(message)+'\n');
    if (bytes.length > MAX_FRAME_BYTES) throw unavailable();
    child.stdin.write(bytes);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    // Child output is not authority: unsolicited frames before admission or
    // after refusal must never reach a callback, even in one coalesced chunk.
    if (!registered || exited || closed || stopping || input.signal?.aborted) {
      rejectPending(unavailable());
      if (!registered) requestStop();
      return;
    }
    if (frame.length+chunk.length > MAX_FRAME_BYTES) {rejectPending(unavailable());requestStop();return;}
    frame=Buffer.concat([frame,chunk]);
    let newline;
    while ((newline=frame.indexOf(10)) >= 0) {
      if (!registered || exited || closed || stopping || input.signal?.aborted) return;
      const line=frame.subarray(0,newline);frame=frame.subarray(newline+1);
      let message: Message;
      try {message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}
      catch {rejectPending(unavailable());requestStop();return;}
      if (!message || typeof message!=='object' || Array.isArray(message)) {rejectPending(unavailable());requestStop();return;}
      if (message.id !== undefined && !message.method) {
        const entry=typeof message.id==='number' ? pending.get(message.id) : undefined;
        if (!entry) {rejectPending(unavailable());requestStop();return;}
        pending.delete(message.id as number);clearTimeout(entry.timer);
        if (message.error !== undefined) entry.reject(new Error('Codex app-server request was rejected.'));
        else entry.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // An unimplemented server request must never acquire owner authority.
        try {write({id:message.id,error:{code:-32601,message:'Server action is not authorized by this transport'}});}
        catch {requestStop();}
      } else if (typeof message.method==='string') {
        try {input.onNotification(Object.freeze(message));}
        catch {rejectPending(unavailable());requestStop();return;}
      } else {rejectPending(unavailable());requestStop();return;}
    }
  });
  const waitClose = async (milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    try {return await Promise.race([close.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally {if(timer)clearTimeout(timer);}
  };
  const stop = async () => {
    if (closed) return;
    stopping=true;child.stdin.end();
    if (!await waitClose(2000)) {requestStop();if(!await waitClose(5000))throw new Error('Owned Codex process close remains unconfirmed.');}
  };
  try {
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const identity=Object.freeze(await captureRuntimeChildIdentity(child.pid!));
    if (exited || closed || input.signal?.aborted) throw unavailable();
    const registration=Object.freeze({identity,requestStop,exit,close});
    registrations.set(registration,input.owner);
    let admissionTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([input.register(registration),close.then(()=>{throw unavailable();}),
        new Promise<never>((_,reject)=>{admissionTimer=setTimeout(()=>reject(unavailable()),admissionTimeoutMs);})]);
    } finally {if(admissionTimer)clearTimeout(admissionTimer);}
    if (exited || closed || stopping || input.signal?.aborted) throw unavailable();
    registered=true;
    return Object.freeze({registration,stop,
      notify(method: 'initialized') {write({method,params:{}});},
      request(method: string, params: unknown, timeoutMs=30000): Promise<unknown> {
        if (!METHODS.has(method) || pending.size >= MAX_PENDING || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000) return Promise.reject(unavailable());
        return new Promise((resolve,reject)=>{
          const id=++sequence;
          const timer=setTimeout(()=>{pending.delete(id);reject(unavailable());requestStop();},timeoutMs);
          pending.set(id,{resolve,reject,timer});
          try {write({id,method,params});}catch(error){pending.delete(id);clearTimeout(timer);reject(error);}
        });
      },
    });
  } catch(error) {
    requestStop();
    try {await stop();} catch(closeError) {
      throw new AggregateError([error,closeError], 'Codex admission failed and process closure remains unconfirmed.');
    }
    throw error;
  }
}
