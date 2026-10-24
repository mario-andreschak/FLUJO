import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';

// Image bytes are transported as base64, but vision models tokenize pixels,
// not the base64 alphabet. Keep ordinary text (including quoted data URLs)
// unchanged. This is a preflight estimate; provider usage remains authoritative.
export function imageTokens(url: string, detail?: string): number {
  if (detail === 'low') return 1024;
  if (url.startsWith('data:image/png;base64,')) {
    const header = Buffer.from(url.slice(22, 22 + 48), 'base64');
    if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
      if (width && height) return Math.ceil(width / 32) * Math.ceil(height / 32) * 3;
    }
  }
  if (/^data:image\/jpe?g;base64,/i.test(url.slice(0, 24))) {
    const start = url.indexOf(',') + 1;
    const header = Buffer.from(url.slice(start, start + 87_384), 'base64');
    for (let offset = 2; offset + 9 < header.length;) {
      if (header[offset] !== 0xff) break;
      const marker = header[offset + 1];
      const length = header.readUInt16BE(offset + 2);
      if (length < 2) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        return Math.ceil(header.readUInt16BE(offset + 5) / 32)
          * Math.ceil(header.readUInt16BE(offset + 7) / 32) * 3;
      }
      offset += length + 2;
    }
  }
  // Remote images and other encodings have no dimensions available here.
  return 8192;
}

export function estimateWireInputTokens(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionFunctionTool[],
  model?: Pick<Model, 'provider' | 'adapter' | 'name'>,
): number {
  let visual = 0;
  const projection = messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => {
      if (part.type !== 'image_url') return part;
      visual += imageTokens(part.image_url.url, part.image_url.detail);
      return { ...part, image_url: { ...part.image_url, url: '[native image]' } };
    }) };
  });
  const json = JSON.stringify({ messages: projection, tools: tools ?? [] });
  return visual + ((model?.provider === 'openrouter' || model?.adapter === 'openrouter-agent') && model?.name.startsWith('anthropic/')
    ? Buffer.byteLength(json, 'utf8') : Math.ceil(json.length / 4));
}
