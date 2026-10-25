import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

export type ConversationSequenceSafetyCode = 'CONVERSATION_SEQUENCE_SCAN_LIMIT'
  | 'CONVERSATION_SEQUENCE_SCAN_BUSY'
  | 'CONVERSATION_SEQUENCE_IO' | 'CONVERSATION_SEQUENCE_CHANGED' | 'CONVERSATION_SEQUENCE_EXHAUSTED'
  | 'CONVERSATION_SEQUENCE_REGISTRY_FULL';

/** A sequence cannot be guessed when the authoritative source is unavailable. */
export class ConversationSequenceSafetyError extends Error {
  readonly status: 429 | 503;
  readonly details: { code: ConversationSequenceSafetyCode; status: number; type: string };
  constructor(readonly code: ConversationSequenceSafetyCode, reason: string, options?: ErrorOptions) {
    super(`Conversation sequence initialization refused: ${reason}. The existing history and sequence high-water mark were preserved.`, options);
    this.name = 'ConversationSequenceSafetyError';
    this.status = code === 'CONVERSATION_SEQUENCE_REGISTRY_FULL' ? 429 : 503;
    this.details = { code, status: this.status, type: 'conversation_sequence_safety_error' };
  }
}

export function isConversationSequenceSafetyError(error: unknown): error is ConversationSequenceSafetyError {
  return error instanceof Error && error.name === 'ConversationSequenceSafetyError';
}

export const CONVERSATION_SEQUENCE_SCAN_LIMITS = Object.freeze({
  bufferBytes: 64 * 1024, maxDepth: 128, maxTokensPerLine: 1_000_000,
  maxSequenceNumberChars: 128, maxMilliseconds: 5_000, maxColdScans: 4,
});

type ScanAdmissionState = { active: number; quarantined: number; refusals: number };
const scanGlobal = globalThis as typeof globalThis & { __flujoConversationSequenceScansV1?: ScanAdmissionState };
const scanAdmission = scanGlobal.__flujoConversationSequenceScansV1 ??= { active: 0, quarantined: 0, refusals: 0 };

export function getConversationSequenceScanDiagnostics() {
  return { scanActive: scanAdmission.active, scanQuarantined: scanAdmission.quarantined,
    scanRefusals: scanAdmission.refusals, maxColdScans: CONVERSATION_SEQUENCE_SCAN_LIMITS.maxColdScans };
}

function admitColdScan() {
  if (scanAdmission.active + scanAdmission.quarantined >= CONVERSATION_SEQUENCE_SCAN_LIMITS.maxColdScans) {
    scanAdmission.refusals++;
    throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_SCAN_BUSY',
      'cold-scan descriptor capacity is occupied; after uncertain descriptor closure, drain work and perform a controlled restart');
  }
  scanAdmission.active++;
  let settled = false;
  return (quarantined = false) => {
    if (settled) return;
    settled = true;
    scanAdmission.active--;
    if (quarantined) scanAdmission.quarantined++;
  };
}

function limit(reason: string): never { throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_SCAN_LIMIT', reason); }
export function requireAllocatableSequence(next: number): void {
  if (!Number.isSafeInteger(next) || next < 0 || next >= Number.MAX_SAFE_INTEGER) {
    throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_EXHAUSTED', 'the next sequence has no safe integer successor');
  }
}

type Frame = { kind: 'object' | 'array'; expect: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd'; seqKey: boolean };
type NumberState = 'minus' | 'zero' | 'integer' | 'dot' | 'fraction' | 'exponent' | 'exponentSign' | 'exponentDigits';
const space = (byte: number) => byte === 32 || byte === 9 || byte === 13;
const digit = (byte: number) => byte >= 48 && byte <= 57;
const hex = (byte: number) => byte >= 48 && byte <= 57 ? byte - 48
  : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;

/** Streaming JSON grammar, retaining only bounded container state and at most
 * 128 characters of a root seq number. String values and object keys are never
 * accumulated. A malformed *complete* line contributes no sequence at all. */
class SequenceLines {
  maximum = -1;
  private frames: Frame[] = [];
  private rootDone = false;
  private invalid = false;
  private tokens = 0;
  private sequence: number | undefined;
  private token: 'none' | 'string' | 'number' | 'literal' = 'none';
  private keyString = false;
  private keyMatches = true;
  private keyLength = 0;
  private escape = false;
  private unicodeLeft = 0;
  private unicodeValue = 0;
  private numberState: NumberState = 'integer';
  private captureNumber = false;
  private numberText = '';
  private literal = '';
  private literalIndex = 0;

  constructor(private readonly maxDepth: number, private readonly maxTokens: number) {}

  private countToken(): void { if (++this.tokens > this.maxTokens) limit('JSON token work exceeds the per-line budget'); }
  private keyUnit(unit: number): void {
    if (this.keyString) {
      if (this.keyLength >= 3 || unit !== 'seq'.charCodeAt(this.keyLength)) this.keyMatches = false;
      this.keyLength++;
    }
  }
  private valueStarted(): boolean {
    const parent = this.frames.at(-1);
    const capture = this.frames.length === 1 && parent?.kind === 'object' && parent.seqKey;
    if (capture) this.sequence = undefined; // Last root property wins, including nonnumeric values.
    if (parent) parent.expect = 'commaOrEnd';
    else this.rootDone = true;
    return Boolean(capture);
  }
  private numberComplete(): boolean {
    return ['zero', 'integer', 'fraction', 'exponentDigits'].includes(this.numberState);
  }
  private finishNumber(): void {
    if (!this.numberComplete()) { this.invalid = true; return; }
    if (this.captureNumber) this.sequence = Number(this.numberText);
    this.token = 'none';
    this.numberText = '';
  }
  private numberByte(byte: number): boolean {
    const current = this.numberState;
    if (current === 'minus' && digit(byte)) this.numberState = byte === 48 ? 'zero' : 'integer';
    else if (current === 'integer' && digit(byte)) { /* more integer digits */ }
    else if ((current === 'integer' || current === 'zero') && byte === 46) this.numberState = 'dot';
    else if ((current === 'integer' || current === 'zero' || current === 'fraction') && (byte === 101 || byte === 69)) this.numberState = 'exponent';
    else if (current === 'dot' && digit(byte)) this.numberState = 'fraction';
    else if (current === 'fraction' && digit(byte)) { /* more fraction digits */ }
    else if (current === 'exponent' && (byte === 43 || byte === 45)) this.numberState = 'exponentSign';
    else if ((current === 'exponent' || current === 'exponentSign') && digit(byte)) this.numberState = 'exponentDigits';
    else if (current === 'exponentDigits' && digit(byte)) { /* more exponent digits */ }
    else return false;
    if (this.captureNumber) {
      if (this.numberText.length >= CONVERSATION_SEQUENCE_SCAN_LIMITS.maxSequenceNumberChars) limit('root sequence numeric token exceeds 128 characters');
      this.numberText += String.fromCharCode(byte);
    }
    return true;
  }
  private stringByte(byte: number): void {
    if (this.unicodeLeft) {
      const value = hex(byte);
      if (value < 0) { this.invalid = true; return; }
      this.unicodeValue = this.unicodeValue * 16 + value;
      if (--this.unicodeLeft === 0) this.keyUnit(this.unicodeValue);
      return;
    }
    if (this.escape) {
      this.escape = false;
      if (byte === 117) { this.unicodeLeft = 4; this.unicodeValue = 0; }
      else if ([34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) this.keyUnit(byte);
      else this.invalid = true;
      return;
    }
    if (byte < 32) { this.invalid = true; return; }
    if (byte === 92) { this.escape = true; return; }
    if (byte === 34) {
      this.token = 'none';
      if (this.keyString) {
        const frame = this.frames.at(-1)!;
        frame.seqKey = this.keyMatches && this.keyLength === 3;
        frame.expect = 'colon';
      }
      return;
    }
    this.keyUnit(byte);
  }
  accept(byte: number): void {
    if (byte === 10) { this.finishLine(); return; }
    if (this.invalid) return;
    if (this.token === 'string') { this.stringByte(byte); return; }
    if (this.token === 'number') {
      if (this.numberByte(byte)) return;
      this.finishNumber();
      if (this.invalid) return;
    } else if (this.token === 'literal') {
      if (this.literalIndex < this.literal.length) {
        if (byte !== this.literal.charCodeAt(this.literalIndex++)) this.invalid = true;
        return;
      }
      this.token = 'none';
    }
    if (space(byte)) return;
    const frame = this.frames.at(-1);
    if (frame?.expect === 'colon') {
      if (byte === 58) frame.expect = 'value'; else this.invalid = true;
      return;
    }
    if (frame?.expect === 'commaOrEnd') {
      if (byte === 44) frame.expect = frame.kind === 'object' ? 'key' : 'value';
      else if (byte === (frame.kind === 'object' ? 125 : 93)) this.frames.pop();
      else this.invalid = true;
      return;
    }
    if (frame?.kind === 'object' && (frame.expect === 'key' || frame.expect === 'keyOrEnd')) {
      if (byte === 125 && frame.expect === 'keyOrEnd') { this.frames.pop(); return; }
      if (byte !== 34) { this.invalid = true; return; }
      this.countToken(); this.token = 'string'; this.keyString = true; this.keyMatches = true; this.keyLength = 0;
      return;
    }
    if (frame?.kind === 'array' && frame.expect === 'valueOrEnd' && byte === 93) { this.frames.pop(); return; }
    if (!frame && this.rootDone) { this.invalid = true; return; }
    this.countToken();
    const capture = this.valueStarted();
    if (byte === 123 || byte === 91) {
      if (this.frames.length >= this.maxDepth) limit('JSON nesting exceeds the bounded scanner depth');
      this.frames.push({ kind: byte === 123 ? 'object' : 'array', expect: byte === 123 ? 'keyOrEnd' : 'valueOrEnd', seqKey: false });
    } else if (byte === 34) {
      this.token = 'string'; this.keyString = false;
    } else if (byte === 45 || digit(byte)) {
      this.token = 'number'; this.captureNumber = capture;
      this.numberState = byte === 45 ? 'minus' : byte === 48 ? 'zero' : 'integer';
      this.numberText = capture ? String.fromCharCode(byte) : '';
    } else if (byte === 116 || byte === 102 || byte === 110) {
      this.token = 'literal'; this.literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; this.literalIndex = 1;
    } else this.invalid = true;
  }
  finishLine(): void {
    if (!this.invalid && this.token === 'number') this.finishNumber();
    if (!this.invalid && this.token === 'literal' && this.literalIndex === this.literal.length) this.token = 'none';
    if (!this.invalid && this.rootDone && this.frames.length === 0 && this.token === 'none' && this.sequence !== undefined) {
      if (!Number.isSafeInteger(this.sequence)) throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_EXHAUSTED', 'a complete event has a non-safe-integer numeric sequence');
      if (this.sequence >= 0) this.maximum = Math.max(this.maximum, this.sequence);
    }
    this.frames.length = 0; this.rootDone = false; this.invalid = false; this.tokens = 0;
    this.sequence = undefined; this.token = 'none'; this.escape = false; this.unicodeLeft = 0; this.numberText = '';
  }
}

export interface SequenceScanOptions { bufferBytes?: number; maxDepth?: number; maxTokensPerLine?: number; maxMilliseconds?: number; now?: () => number }

/** Scan every line of one descriptor snapshot. No readFile/split/JSON.parse or
 * pathname reopen, including the final regular-file/snapshot validation. */
export function scanConversationLogSequence(file: string, options: SequenceScanOptions = {}): number {
  const configuredTime = process.env.FLUJO_CONVERSATION_SEQUENCE_SCAN_MAX_MS;
  const settings = { ...CONVERSATION_SEQUENCE_SCAN_LIMITS,
    maxMilliseconds: configuredTime === undefined ? CONVERSATION_SEQUENCE_SCAN_LIMITS.maxMilliseconds : Number(configuredTime),
    ...options };
  for (const value of [settings.bufferBytes, settings.maxDepth, settings.maxTokensPerLine, settings.maxMilliseconds]) {
    if (!Number.isSafeInteger(value) || value < 1) limit('scanner limits must be positive safe integers');
  }
  if (settings.bufferBytes > CONVERSATION_SEQUENCE_SCAN_LIMITS.bufferBytes || settings.maxDepth > CONVERSATION_SEQUENCE_SCAN_LIMITS.maxDepth) limit('scanner allocation limits cannot be increased');
  const now = options.now ?? (() => performance.now());
  const started = now();
  const settleScan = admitColdScan(); // Before open: uncertain closes retain this finite ownership slot.
  let descriptor: number;
  try { descriptor = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    settleScan(); // A failed open supplied no descriptor.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return -1;
    throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_IO', 'the log could not be opened; restore storage access before retrying', { cause: error });
  }
  let failure: unknown;
  try {
    const initial = fstatSync(descriptor, { bigint: true });
    if (!initial.isFile() || initial.size < BigInt(0) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_IO', 'the opened log is not a regular file with a safe snapshot size');
    }
    const parser = new SequenceLines(settings.maxDepth, settings.maxTokensPerLine);
    const buffer = Buffer.alloc(settings.bufferBytes);
    const size = Number(initial.size);
    let offset = 0;
    while (offset < size) {
      if (now() - started > settings.maxMilliseconds) limit('the full-history scan exceeded its time budget; provision a longer scan window before retrying');
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_CHANGED', 'the log shrank during its sequence scan; retry against a stable history');
      offset += count;
      for (let index = 0; index < count; index++) parser.accept(buffer[index]);
    }
    parser.finishLine();
    const final = fstatSync(descriptor, { bigint: true });
    if (!final.isFile() || final.size !== initial.size || final.mtimeNs !== initial.mtimeNs || final.ctimeNs !== initial.ctimeNs) {
      throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_CHANGED', 'the log changed during its sequence scan; retry against a stable history');
    }
    if (now() - started > settings.maxMilliseconds) limit('the full-history scan exceeded its time budget; provision a longer scan window before retrying');
    return parser.maximum;
  } catch (error) {
    failure = isConversationSequenceSafetyError(error) ? error
      : new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_IO', 'the log could not be read; restore storage access before retrying', { cause: error });
    throw failure;
  } finally {
    try { closeSync(descriptor); settleScan(); }
    catch (error) {
      // Never retry the numeric descriptor: close may have succeeded before
      // reporting failure and that number may already identify another owner.
      settleScan(true);
      if (!failure) throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_IO', 'the log descriptor could not be closed safely', { cause: error });
    }
  }
}
