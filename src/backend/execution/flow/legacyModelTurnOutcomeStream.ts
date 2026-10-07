import { constants, createWriteStream, promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { Readable, Transform, type TransformCallback } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import { TextDecoder } from 'util';
import type { ModelDispatchOutcome } from '@/shared/types/modelTurn';
import { assertWorkspaceMutationOwned } from '@/backend/services/workspace/workspaceMutationGate';
import { MODEL_TURN_ARCHIVE_READ_LIMITS, ModelTurnArchiveReadError } from './modelTurnArchiveReadBudget';

const CHUNK = 64 * 1024;
type Frame = { object: boolean; root: boolean; entry: boolean; state: string; key?: string; fields: number; outcome: boolean };
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const digit = (byte: number) => byte >= 48 && byte <= 57;
const limitError = () => new ModelTurnArchiveReadError('MODEL_TURN_ARCHIVE_READ_LIMIT',
  'Legacy model-turn outcome exceeds archive limits. The persisted archive is unchanged.');

/** Validate JSON incrementally; edit only root.entry.outcome, preserving all other bytes. */
export class LegacyModelTurnOutcomeTransform extends Transform {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  private readonly frames: Frame[] = [];
  private readonly replacement: Buffer;
  private lex: 'string' | 'number' | 'literal' | undefined;
  private stringKey = false;
  private keyBytes: number[] | undefined;
  private escape = false;
  private unicode = 0;
  private numberState = '';
  private literal = '';
  private literalOffset = 0;
  private started = false;
  private ended = false;
  private entrySeen = false;
  private suppressedAt: number | undefined;
  private decodedBytes = 0;

  constructor(outcome: Exclude<ModelDispatchOutcome, 'running'>) {
    super({ highWaterMark: CHUNK });
    this.replacement = Buffer.from(JSON.stringify(outcome));
  }

  private invalid(): never { throw new SyntaxError('Invalid legacy model-turn JSON.'); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      this.decodedBytes += chunk.length;
      if (this.decodedBytes > MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes) throw limitError();
      this.utf8.decode(chunk, { stream: true });
      let span = 0;
      const emitBefore = (offset: number) => {
        if (this.suppressedAt === undefined && offset > span) this.push(chunk.subarray(span, offset));
        span = offset;
      };
      const finishValue = (offset: number) => {
        const parent = this.frames.at(-1);
        if (!parent || parent.state !== 'value') this.invalid();
        parent.state = 'comma';
        if (this.suppressedAt === this.frames.length) {
          this.push(this.replacement);
          this.suppressedAt = undefined;
          span = offset;
        }
      };
      const beginValue = (offset: number) => {
        const parent = this.frames.at(-1);
        if (parent?.entry && parent.key === 'outcome') {
          emitBefore(offset);
          this.suppressedAt = this.frames.length;
          parent.outcome = true;
        }
      };
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i];
        if (this.lex === 'string') {
          if (this.keyBytes) {
            if (this.keyBytes.length < 512) this.keyBytes.push(byte);
            else this.keyBytes = undefined;
          }
          if (this.unicode) {
            if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102))) this.invalid();
            this.unicode--;
          } else if (this.escape) {
            this.escape = false;
            if (byte === 117) this.unicode = 4;
            else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) this.invalid();
          } else if (byte === 92) this.escape = true;
          else if (byte === 34) {
            this.lex = undefined;
            if (this.stringKey) {
              const parent = this.frames.at(-1)!;
              parent.key = this.keyBytes ? JSON.parse(Buffer.from(this.keyBytes).toString('utf8')) : undefined;
              parent.fields++;
              parent.state = 'colon';
            } else finishValue(i + 1);
            this.keyBytes = undefined;
          } else if (byte < 32) this.invalid();
          continue;
        }
        if (this.lex === 'literal') {
          if (byte !== this.literal.charCodeAt(this.literalOffset++)) this.invalid();
          if (this.literalOffset === this.literal.length) { this.lex = undefined; finishValue(i + 1); }
          continue;
        }
        if (this.lex === 'number') {
          const state = this.numberState;
          if ((state === 'sign' || state === 'integer') && digit(byte)) {
            this.numberState = state === 'sign' && byte === 48 ? 'zero' : 'integer'; continue;
          }
          if ((state === 'integer' || state === 'zero') && byte === 46) { this.numberState = 'dot'; continue; }
          if ((state === 'dot' || state === 'fraction') && digit(byte)) { this.numberState = 'fraction'; continue; }
          if (['integer', 'zero', 'fraction'].includes(state) && (byte === 101 || byte === 69)) { this.numberState = 'exponent'; continue; }
          if (state === 'exponent' && (byte === 43 || byte === 45)) { this.numberState = 'exponentSign'; continue; }
          if (['exponent', 'exponentSign', 'exponentDigits'].includes(state) && digit(byte)) { this.numberState = 'exponentDigits'; continue; }
          if (!['integer', 'zero', 'fraction', 'exponentDigits'].includes(state)) this.invalid();
          this.lex = undefined;
          finishValue(i);
          // The delimiter belongs to the containing JSON value, not the number.
        }
        if (whitespace(byte)) continue;
        if (this.ended) this.invalid();
        if (!this.started) {
          if (byte !== 123) this.invalid();
          this.started = true;
          this.frames.push({ object: true, root: true, entry: false, state: 'keyEnd', fields: 0, outcome: false });
          continue;
        }
        const parent = this.frames.at(-1)!;
        if ((parent.state === 'keyEnd' || parent.state === 'key') && byte === 34) {
          this.lex = 'string'; this.stringKey = true; this.keyBytes = [34]; continue;
        }
        if (parent.state === 'colon' && byte === 58) { parent.state = 'value'; continue; }
        const closing = parent.object ? 125 : 93;
        if (byte === closing && ['keyEnd', 'valueEnd', 'comma'].includes(parent.state)) {
          if (parent.entry && !parent.outcome) {
            emitBefore(i);
            this.push(Buffer.concat([Buffer.from(`${parent.fields ? ',' : ''}"outcome":`), this.replacement]));
          }
          this.frames.pop();
          if (!this.frames.length) this.ended = true;
          else finishValue(i + 1);
          continue;
        }
        if (parent.state === 'comma' && byte === 44) {
          parent.state = parent.object ? 'key' : 'value'; parent.key = undefined; continue;
        }
        if (!['value', 'valueEnd'].includes(parent.state)) this.invalid();
        parent.state = 'value';
        beginValue(i);
        if (byte === 123 || byte === 91) {
          const entry = parent.root && parent.key === 'entry';
          if (entry && byte !== 123) this.invalid();
          if (entry) this.entrySeen = true;
          if (this.frames.length >= 65536) throw limitError();
          this.frames.push({ object: byte === 123, root: false, entry,
            state: byte === 123 ? 'keyEnd' : 'valueEnd', fields: 0, outcome: false });
        } else {
          if (parent.root && parent.key === 'entry') this.invalid();
          if (byte === 34) { this.lex = 'string'; this.stringKey = false; }
          else if (byte === 45 || digit(byte)) {
            this.lex = 'number'; this.numberState = byte === 45 ? 'sign' : byte === 48 ? 'zero' : 'integer';
          } else if (byte === 116 || byte === 102 || byte === 110) {
            this.lex = 'literal'; this.literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'; this.literalOffset = 1;
          } else this.invalid();
        }
      }
      emitBefore(chunk.length);
      callback();
    } catch (error) { callback(error as Error); }
  }

  override _flush(callback: TransformCallback) {
    try {
      this.utf8.decode();
      if (!this.ended || !this.entrySeen || this.lex || this.frames.length || this.suppressedAt !== undefined) this.invalid();
      callback();
    } catch (error) { callback(error as Error); }
  }
}

/** Atomic, backpressured rewrite; no complete decoded buffer, string, or object. */
export async function rewriteLegacyModelTurnOutcome(file: string, outcome: Exclude<ModelDispatchOutcome, 'running'>) {
  const source = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let sourceClosed = false;
  try {
    const stat = await source.stat();
    if (!stat.isFile()) throw new Error('Model-turn archive is not a regular file.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes) throw limitError();
    const read = async function* () {
      let offset = 0;
      while (offset <= stat.size) {
        const bytes = Buffer.alloc(Math.min(CHUNK, stat.size + 1 - offset));
        const { bytesRead } = await source.read(bytes, 0, bytes.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > stat.size) throw new Error('Model-turn archive changed during inspection. Retry the read.');
        yield bytes.subarray(0, bytesRead);
      }
      if (offset !== stat.size) throw new Error('Model-turn archive changed during inspection. Retry the read.');
    };
    const boundedOutput = (limit: number) => {
      let written = 0;
      return new Transform({ highWaterMark: CHUNK, transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        callback(written > limit ? limitError() : undefined, chunk);
      } });
    };
    await assertWorkspaceMutationOwned();
    await pipeline(Readable.from(read()), createGunzip({ chunkSize: CHUNK }), new LegacyModelTurnOutcomeTransform(outcome),
      boundedOutput(MODEL_TURN_ARCHIVE_READ_LIMITS.decodedSnapshotBytes), createGzip({ chunkSize: CHUNK }),
      boundedOutput(MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes), createWriteStream(temporary, { flags: 'wx', highWaterMark: CHUNK }));
    await source.close(); sourceClosed = true;
    await assertWorkspaceMutationOwned();
    await fs.rename(temporary, file);
  } finally {
    if (!sourceClosed) await source.close();
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
