import type { InputType, ZlibOptions } from 'zlib';

declare module 'zlib' {
  /** With `info: true` Node returns the output together with the engine that produced it. */
  function inflateRawSync(
    buf: InputType,
    options: ZlibOptions & { info: true },
  ): { buffer: Buffer; engine: { bytesWritten: number } };
}
