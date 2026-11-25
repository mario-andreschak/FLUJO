import sharp, { type Sharp } from 'sharp';
import { yieldToEventLoop } from './textBudget';

/**
 * Turn images most models cannot read (HEIC, AVIF, TIFF, BMP, SVG) into PNG,
 * and shrink very large images so they fit what one chat message can carry.
 * sharp decodes on libuv's thread pool, so the event loop stays free.
 */
export interface ConvertedImage {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export class ImageConvertError extends Error {}

const MAX_SIDE = 4096;
// Same pixel ceiling as the provider image preparation: rejects decompression bombs.
const MAX_INPUT_PIXELS = 268_402_689;

/** Uncompressed BMP (8, 24 or 32 bit), which libvips cannot read, as raw RGBA. */
export async function decodeBmp(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length < 54 || view.toString('latin1', 0, 2) !== 'BM') throw new ImageConvertError('Not a BMP image');
  const pixelOffset = view.readUInt32LE(10);
  const headerSize = view.readUInt32LE(14);
  const width = view.readInt32LE(18);
  const rawHeight = view.readInt32LE(22);
  const bits = view.readUInt16LE(28);
  const compression = view.readUInt32LE(30);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  if (width <= 0 || height <= 0 || width * height > MAX_INPUT_PIXELS) throw new ImageConvertError('Unsupported BMP size');
  if (![8, 24, 32].includes(bits) || !(compression === 0 || (compression === 3 && bits === 32))) {
    throw new ImageConvertError('Unsupported BMP encoding');
  }
  const paletteSize = bits === 8 ? (view.readUInt32LE(46) || 256) : 0;
  const paletteStart = 14 + headerSize;
  const rowSize = Math.ceil((bits * width) / 32) * 4;
  if (pixelOffset + rowSize * height > view.length) throw new ImageConvertError('Truncated BMP image');
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (y % 256 === 255) await yieldToEventLoop();
    const source = pixelOffset + (bottomUp ? height - 1 - y : y) * rowSize;
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      let blue: number, green: number, red: number, alpha = 255;
      if (bits === 8) {
        const index = Math.min(view[source + x], paletteSize - 1);
        const entry = paletteStart + index * 4;
        [blue, green, red] = [view[entry], view[entry + 1], view[entry + 2]];
      } else {
        const pixel = source + x * (bits / 8);
        [blue, green, red] = [view[pixel], view[pixel + 1], view[pixel + 2]];
        if (bits === 32 && compression === 3) alpha = view[pixel + 3];
      }
      data[target] = red;
      data[target + 1] = green;
      data[target + 2] = blue;
      data[target + 3] = alpha;
    }
  }
  return { data, width, height };
}

async function open(bytes: Uint8Array, mimeType: string): Promise<Sharp> {
  if (mimeType === 'image/bmp' || mimeType === 'image/x-ms-bmp') {
    const { data, width, height } = await decodeBmp(bytes);
    return sharp(data, { raw: { width, height, channels: 4 } });
  }
  return sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true }).autoOrient();
}

/**
 * Encode as PNG; fall back to JPEG and then smaller sizes until the result
 * fits `maxBytes`. The first frame of an animation is kept.
 */
export async function convertImage(
  bytes: Uint8Array,
  mimeType: string,
  maxBytes: number,
): Promise<ConvertedImage> {
  let image: Sharp;
  let width: number;
  let height: number;
  try {
    image = await open(bytes, mimeType);
    const metadata = await image.metadata();
    width = metadata.autoOrient?.width ?? metadata.width ?? 0;
    height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  } catch (error) {
    throw error instanceof ImageConvertError ? error : new ImageConvertError('This image could not be decoded', { cause: error });
  }
  if (!width || !height) throw new ImageConvertError('This image has no size');

  let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const resized = image.clone().resize(targetWidth, targetHeight, { fit: 'fill' });
    try {
      const png = await resized.clone().png().toBuffer();
      if (png.length <= maxBytes) return { bytes: png, mimeType: 'image/png', width: targetWidth, height: targetHeight };
      const jpeg = await resized.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
      if (jpeg.length <= maxBytes) return { bytes: jpeg, mimeType: 'image/jpeg', width: targetWidth, height: targetHeight };
      scale *= Math.max(0.3, Math.min(0.8, Math.sqrt(maxBytes / jpeg.length)));
    } catch (error) {
      throw new ImageConvertError('This image could not be converted', { cause: error });
    }
  }
  throw new ImageConvertError('This image stays too large after shrinking');
}
