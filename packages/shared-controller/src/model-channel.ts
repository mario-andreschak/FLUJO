import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { grantId, MODEL_BODY_BYTES } from './model-grant.js';

const id = z.string().regex(/^[a-f0-9]{32}$/);
export const runtimeModelFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(), z.object({ type: z.literal('pong') }).strict(),
  z.object({ type: z.literal('request'), id, grant: grantId, operation: z.enum(['models', 'chat', 'embeddings']), body: z.unknown().optional() }).strict(),
  z.object({ type: z.literal('cancel'), id }).strict(),
  z.object({ type: z.literal('ack'), id, sequence: z.number().int().nonnegative() }).strict(),
]);
export const hostModelFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('headers'), id, contentType: z.enum(['application/json', 'text/event-stream']) }).strict(),
  z.object({ type: z.literal('chunk'), id, sequence: z.number().int().nonnegative(),
    bytes: z.string().max(65536).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
  z.object({ type: z.literal('end'), id }).strict(),
  z.object({ type: z.literal('error'), id, code: z.enum(['unavailable', 'denied', 'invalid_request', 'busy']) }).strict(),
]);
export type HostModelFrame = z.infer<typeof hostModelFrame>;
export type RuntimeModelFrame = z.infer<typeof runtimeModelFrame>;
const MAX_FRAME = MODEL_BODY_BYTES + 4096;
const MAX_QUEUED = 4 * MAX_FRAME;

/** Bounded binary framing; partial one-byte input cannot trigger quadratic
 * concatenation. Credit acknowledgements bound streaming response buffering. */
export class ModelChannel {
  private header = Buffer.alloc(4); private headerBytes = 0;
  private payload?: Buffer; private received = 0; private queued = 0; private closed = false;
  private window = performance.now(); private frames = 0; private bytes = 0;
  constructor(readonly input: Readable, readonly output: Writable, readonly receive: (value: unknown) => void,
    readonly failed: () => void) {
    input.on('data', this.read); input.on('end', this.close); input.on('close', this.close); input.on('error', this.close);
    output.on('error', this.close); output.on('close', this.close);
  }
  private read = (chunk: Buffer) => {
    if (this.closed) return;
    try {
      if (performance.now() - this.window >= 10_000) { this.window = performance.now(); this.frames = 0; this.bytes = 0; }
      this.bytes += chunk.length;
      if (this.bytes > MAX_QUEUED * 2) throw new Error('Channel input rate exceeded.');
      let at = 0;
      while (at < chunk.length && !this.closed) {
        if (!this.payload) {
          const count = Math.min(4 - this.headerBytes, chunk.length - at);
          chunk.copy(this.header, this.headerBytes, at, at + count); this.headerBytes += count; at += count;
          if (this.headerBytes !== 4) continue;
          const length = this.header.readUInt32BE();
          if (!length || length > MAX_FRAME || ++this.frames > 4096) throw new Error('Invalid model frame.');
          this.payload = Buffer.allocUnsafe(length); this.received = 0;
        }
        const count = Math.min(this.payload.length - this.received, chunk.length - at);
        chunk.copy(this.payload, this.received, at, at + count); this.received += count; at += count;
        if (this.received === this.payload.length) {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.payload));
          this.payload = undefined; this.headerBytes = 0; this.receive(value);
        }
      }
    } catch { this.close(); }
  };
  send(value: HostModelFrame | RuntimeModelFrame): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Model channel closed.'));
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > MAX_FRAME || this.queued + data.length + 4 > MAX_QUEUED) {
      this.close(); return Promise.reject(new Error('Model channel capacity exceeded.'));
    }
    const frame = Buffer.allocUnsafe(data.length + 4); frame.writeUInt32BE(data.length); data.copy(frame, 4);
    this.queued += frame.length;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return; settled = true; clearTimeout(deadline); this.queued -= frame.length;
        if (error || this.closed) reject(new Error('Model channel closed.')); else resolve();
      };
      // A peer cannot keep host slots forever by sending pongs while refusing
      // to read its own pipe. Slow HTTP consumers use chunk credits separately.
      const deadline = setTimeout(() => { this.close(); finish(new Error('Model channel write unavailable.')); }, 10_000);
      try { this.output.write(frame, finish); } catch { this.close(); finish(new Error('Model channel write failed.')); }
    });
  }
  close = () => {
    if (this.closed) return;
    this.closed = true; this.payload = undefined;
    this.input.off('data', this.read); this.input.destroy(); this.output.destroy(); this.failed();
  };
}
