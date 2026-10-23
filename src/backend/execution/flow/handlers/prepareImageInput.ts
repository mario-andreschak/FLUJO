import sharp from 'sharp';
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { estimateWireInputTokens } from './wireTokenEstimate';

type Message = OpenAI.ChatCompletionMessageParam;
type ModelIdentity = Pick<Model, 'provider' | 'adapter' | 'name'>;

/** A provider projection only: the original attachment and canonical transcript
 * remain unchanged. Process sequentially so a batch of 8K images does not decode
 * every full-resolution raster at once. */
export async function prepareImageInput(
  messages: Message[],
  options: {
    inputBudget?: number;
    tools?: OpenAI.ChatCompletionFunctionTool[];
    model?: ModelIdentity;
    maxImageTokens?: number;
    shouldAbort?: () => boolean;
    resolve?: (url: string) => Promise<string>;
    preserve?: (url: string) => Promise<string | undefined>;
  } = {},
): Promise<Message[]> {
  const images = messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url') : []);
  if (!images.length) return messages;
  const textOnly = messages.map(message => Array.isArray(message.content)
    ? { ...message, content: message.content.filter(part => part.type !== 'image_url') } as Message : message);
  let textTokens = estimateWireInputTokens(textOnly, options.tools, options.model);
  // Some vision encoders upscale even a tiny raster to a minimum patch grid.
  // Multiple postage-stamp views therefore do not converge toward zero cost.
  // Page older images out only after preserving their exact original; the most
  // recent view (often a requested crop) keeps the available pixel budget.
  const deferred = new Map<number, string>();
  if (options.inputBudget !== undefined && options.preserve && images.length > 1) {
    for (let index = 0; index < images.length - 1; index++) {
      if (textTokens + (images.length - deferred.size) * 1024 <= options.inputBudget) break;
      if (options.shouldAbort?.()) throw new DOMException('Image preparation cancelled', 'AbortError');
      const uri = await options.preserve(images[index].image_url.url);
      if (!uri) continue;
      const marker = `[Earlier image archived to fit: ${uri}. Use read_resource to inspect it.]`;
      deferred.set(index, marker);
      textTokens += Math.ceil(marker.length / 4);
    }
  }
  const visibleImages = images.length - deferred.size;
  // Leave room for per-image framing and the exact-source locator.
  const available = options.inputBudget === undefined ? 32_768 * visibleImages
    : Math.max(3 * visibleImages, options.inputBudget - textTokens - 96 * visibleImages);
  const perImage = Math.max(3, Math.min(options.maxImageTokens ?? 32_768,
    Math.floor(available * 0.85 / visibleImages)));
  const maxPatches = Math.max(1, Math.floor(perImage / 3));
  const cache = new Map<string, { url: string; source?: string; width: number; height: number }>();
  let changed = false;
  let imageIndex = 0;
  const result: Message[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) { result.push(message); continue; }
    const content = [];
    for (const part of message.content) {
      if (part.type !== 'image_url') { content.push(part); continue; }
      const archived = deferred.get(imageIndex++);
      if (archived) { content.push({ type: 'text' as const, text: archived }); changed = true; continue; }
      if (options.shouldAbort?.()) throw new DOMException('Image preparation cancelled', 'AbortError');
      const original = part.image_url.url;
      let prepared = cache.get(original);
      if (!prepared) {
        const resolved = await options.resolve?.(original) ?? original;
        const comma = resolved.indexOf(',');
        const prefix = comma >= 0 && comma < 128 ? resolved.slice(0, comma) : '';
        if (!/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64$/i.test(prefix)) {
          content.push(part); continue;
        }
        const bytes = Buffer.from(resolved.slice(comma + 1), 'base64');
        // libvips decodes only the first frame; preserve animated sources in the
        // canonical attachment. Its pixel limit also rejects decompression bombs.
        const decoder = sharp(bytes, { limitInputPixels: 268_402_689, sequentialRead: true }).autoOrient();
        const metadata = await decoder.metadata();
        let width = metadata.autoOrient?.width ?? metadata.width;
        let height = metadata.autoOrient?.height ?? metadata.height;
        if (!width || !height) { content.push(part); continue; }
        const originalWidth = width, originalHeight = height;
        const scale = Math.min(1, 4096 / Math.max(width, height),
          Math.sqrt(maxPatches * 32 * 32 / (width * height)));
        width = Math.max(1, Math.floor(width * scale));
        height = Math.max(1, Math.floor(height * scale));
        while (Math.ceil(width / 32) * Math.ceil(height / 32) > maxPatches) {
          if (width >= height && width > 1) width = Math.max(1, (Math.ceil(width / 32) - 1) * 32);
          else height = Math.max(1, (Math.ceil(height / 32) - 1) * 32);
        }
        const needsResize = width < originalWidth || height < originalHeight;
        let url = resolved;
        if (needsResize || bytes.length > 4 * 1024 * 1024) {
          const resized = decoder.resize(width, height, { fit: 'fill', withoutEnlargement: true });
          let encoded = await resized.png().toBuffer();
          let mime = 'image/png';
          if (encoded.length > 4 * 1024 * 1024) {
            encoded = await resized.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
            mime = 'image/jpeg';
          }
          url = 'data:' + mime + ';base64,' + encoded.toString('base64');
        }
        if (options.shouldAbort?.()) throw new DOMException('Image preparation cancelled', 'AbortError');
        prepared = { url, width: originalWidth, height: originalHeight,
          ...(url !== resolved ? { source: await options.preserve?.(original) } : {}) };
        cache.set(original, prepared);
      }
      if (prepared.url !== original) changed = true;
      content.push({ ...part, image_url: { ...part.image_url, url: prepared.url } });
      if (prepared.source) content.push({ type: 'text' as const,
        text: options.inputBudget !== undefined && options.inputBudget < 8192
          ? `[Resized image; original: ${prepared.source} (${prepared.width} x ${prepared.height}). Verify exact text with read_resource.image_region in original pixels.]`
          : `[Image overview resized to fit. Full-resolution original: ${prepared.source} (${prepared.width} x ${prepared.height} pixels). `
          + 'Use read_resource with image_region {left,top,width,height} in original pixels to inspect fine details. '
          + 'For exact text, identifiers or numbers, verify the relevant crop before answering.]' });
    }
    result.push({ ...message, content } as Message);
  }
  return changed ? result : messages;
}
