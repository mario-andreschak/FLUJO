import { createHash } from 'crypto';
import { Transform, type TransformCallback } from 'stream';

/** Fixed-size transport records; never materialize the archived JSON value. */
export class ModelTurnSnapshotChunks extends Transform {
  private readonly hash = createHash('sha256');
  private bytes = 0;
  constructor() { super({ highWaterMark: 64 * 1024 }); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      const part = chunk.subarray(offset, offset + 64 * 1024);
      this.bytes += part.length;
      this.hash.update(part);
      this.push(JSON.stringify({ kind: 'chunk', data: part.toString('base64') }) + '\n');
    }
    callback();
  }
  override _flush(callback: TransformCallback) {
    this.push(JSON.stringify({ kind: 'end', bytes: this.bytes, sha256: this.hash.digest('hex') }) + '\n');
    callback();
  }
}
