import type OpenAI from 'openai';
import type { DecodedTool } from './toolNamespace';
import type { NativeInvocationReceipt } from './nativeToolJournal';
import type { NativeLineageRootBinding, NativeOriginLineageEvidence } from './nativeOriginLineage';
import type { ModelTurnMediaDescriptor } from '@/shared/types/modelTurn';

export type NativeSessionSdkOutcome = 'completed' | 'error' | 'cancelled';
export type NativeSessionPhase = 'prepared' | 'issue-uncertain' | 'confirmed-live' | 'sdk-finished' | 'terminal' | 'held';
export type NativeSessionTerminal = { state: 'terminal'; outcome: 'completed' } | { state: 'held' };
export type NativeSessionEvent = Readonly<{
  invocationId: string;
  /** In-process notification order, not a durable SDK or host event cursor. */
  sequence: number;
  kind: 'issue-uncertain' | 'confirmed-live' | 'sdk-finished' | 'sdk-outcome' | 'terminal' | 'held';
  outcome?: NativeSessionSdkOutcome;
}>;

/** All payloads here are saved, sanitized snapshots. No credential or executor closure is copied. */
export interface NativeInvocationSessionDescriptor {
  receipt: NativeInvocationReceipt;
  lineage: NativeOriginLineageEvidence;
  archive: {
    dispatchId: string;
    /** Missing only on historical V1 descriptors; never inferred for V2. */
    archiveVersion?: 1 | 2;
    adapter: string;
    operation: string;
    /** Hashes of the saved sanitized archive fields. Neither is a commitment
     * to raw transformed SDK bytes or equal to receipt.owner.inputDigest. */
    sanitizedSdkRequestDigest: string;
    sanitizedGenericWireDigest: string;
    mediaCount: number;
  };
  inventory: {
    digest: string;
    toolCount: number;
  };
  payloadRef: NativeInvocationSessionPayloadRef;
}

export interface NativeInvocationSessionPayload {
  invocationId: string;
  archive: {
    sdkRequest: unknown;
    genericWire: OpenAI.ChatCompletionMessageParam[];
    media: ModelTurnMediaDescriptor[];
  };
  inventory: {
    tools: OpenAI.ChatCompletionFunctionTool[];
    bindings: Record<string, DecodedTool>;
    syntheticNames: string[];
  };
}

export interface NativeInvocationSessionPayloadRef {
  kind: 'private-native-session-payload';
  invocationId: string;
  sha256: string;
  byteLength: number;
}

/** Opaque local handle for the one original in-process SDK invocation. Its
 * events are live notifications; the journal remains the durable authority. */
export interface NativeInvocationSession {
  readonly descriptor: Readonly<NativeInvocationSessionDescriptor>;
  readonly signal: AbortSignal;
  phase(): NativeSessionPhase;
  cancel(): void;
  subscribe(listener: (event: NativeSessionEvent) => void): () => void;
  waitTerminal(): Promise<NativeSessionTerminal>;
}

/** A future authenticated host adapter supplies this closure. It must persist
 * same-ID acceptance and outcomes before acknowledging; no transport exists here. */
export interface NativeInvocationSessionHook {
  readonly root: NativeLineageRootBinding;
  publish(session: NativeInvocationSession): Promise<void>;
  acknowledgeSdkOutcome(session: NativeInvocationSession, outcome: NativeSessionSdkOutcome): Promise<void>;
  acknowledgeLive(session: NativeInvocationSession): Promise<void>;
  /** Durable terminal-ready acknowledgement only. The host cannot release a
   * goal hold until it rereads the source's terminal journal with its hold gone. */
  acknowledgeTerminalReady(session: NativeInvocationSession): Promise<void>;
}

const hooks = new WeakSet<object>();

export function createNativeInvocationSessionHook(input: NativeInvocationSessionHook): NativeInvocationSessionHook {
  if (!input || typeof input !== 'object' || !input.root
    || typeof input.publish !== 'function' || typeof input.acknowledgeSdkOutcome !== 'function'
    || typeof input.acknowledgeLive !== 'function'
    || typeof input.acknowledgeTerminalReady !== 'function') {
    throw new Error('Native invocation session hook is incomplete.');
  }
  const hook = Object.freeze({ ...input });
  hooks.add(hook);
  return hook;
}

export function assertNativeInvocationSessionHook(value: unknown): asserts value is NativeInvocationSessionHook {
  if (!value || typeof value !== 'object' || !hooks.has(value)) {
    throw new Error('Native invocation session hook must be an in-process capability.');
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** ModelHandler alone owns emission and settlement. The hook receives only the
 * frozen session, never the producer methods. */
export function createNativeInvocationSession(
  descriptor: NativeInvocationSessionDescriptor,
  signal: AbortSignal,
  cancelOriginal: () => void,
): {
  session: NativeInvocationSession;
  emit: (kind: NativeSessionEvent['kind'], outcome?: NativeSessionSdkOutcome) => void;
  settle: (terminal: NativeSessionTerminal) => void;
} {
  if (Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > 16 * 1024) {
    throw new Error('Native session descriptor exceeds the host ledger envelope bound.');
  }
  const frozen = deepFreeze(structuredClone(descriptor));
  const listeners = new Set<(event: NativeSessionEvent) => void>();
  let sequence = 0;
  let phase: NativeSessionPhase = 'prepared';
  let terminalResolve!: (value: NativeSessionTerminal) => void;
  let settled = false;
  const terminal = new Promise<NativeSessionTerminal>(resolve => { terminalResolve = resolve; });
  const emit = (kind: NativeSessionEvent['kind'], outcome?: NativeSessionSdkOutcome) => {
    if (kind !== 'sdk-outcome') phase = kind;
    const event = Object.freeze({ invocationId: frozen.receipt.invocationId, sequence: ++sequence,
      kind, ...(outcome ? { outcome } : {}) });
    for (const listener of listeners) {
      try { listener(event); } catch { /* Observation cannot change the original SDK call. */ }
    }
  };
  const session: NativeInvocationSession = Object.freeze({
    descriptor: frozen,
    signal,
    phase: () => phase,
    // A finished SDK stream can still have a pending outcome or source terminal
    // write. Stop must fence that write until the durable source hold is clear.
    cancel: () => { if (!settled) cancelOriginal(); },
    subscribe: (listener: (event: NativeSessionEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    waitTerminal: () => terminal,
  });
  const settle = (result: NativeSessionTerminal) => {
    if (settled) return;
    settled = true;
    emit(result.state);
    terminalResolve(result);
    listeners.clear();
  };
  return { session, emit, settle };
}
