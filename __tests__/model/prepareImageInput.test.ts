import sharp from 'sharp';
import type OpenAI from 'openai';
import { prepareImageInput } from '@/backend/execution/flow/handlers/prepareImageInput';
import { estimateWireInputTokens } from '@/backend/execution/flow/handlers/wireTokenEstimate';

describe('automatic image preparation', () => {
  let original: Buffer;
  beforeAll(async () => {
    original = await sharp({ create: { width: 7680, height: 4320, channels: 3, background: '#123456' } })
      .composite([{ input: Buffer.from('<svg width="7680" height="4320"><text x="100" y="200" font-size="120" fill="white">Exact source 8K</text></svg>') }])
      .png().toBuffer();
  });
  it.each([1024, 2048, 4096, 16_384, 200_000, 1_050_000])(
    'fits a real 8K image inside a %i-token input budget, preserving source identity', async inputBudget => {
    const url = 'data:image/png;base64,' + original.toString('base64');
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: [
      { type: 'text', text: 'Read the image.' }, { type: 'image_url', image_url: { url } },
    ] }];
    const preserve = jest.fn(async () => 'flujo://run/test/original');
    const wire = await prepareImageInput(messages, { inputBudget, preserve });
    expect(estimateWireInputTokens(wire)).toBeLessThan(inputBudget);
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'Read the image.' }, { type: 'image_url', image_url: { url } },
    ]);
    expect(preserve).toHaveBeenCalledWith(url);
    const part = (wire[0].content as OpenAI.ChatCompletionContentPart[]).find(p => p.type === 'image_url')!;
    const size = await sharp(Buffer.from(part.image_url.url.split(',')[1], 'base64')).metadata();
    expect(size.width).toBeLessThanOrEqual(4096);
    expect(size.width! / size.height!).toBeCloseTo(7680 / 4320, 0);
  });
  it.each(['jpeg', 'webp', 'gif'] as const)('prepares %s input before estimating the outgoing image', async format => {
    const bytes = await sharp(original).toFormat(format).toBuffer();
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/' + format + ';base64,' + bytes.toString('base64') } },
    ] }];
    expect(estimateWireInputTokens(await prepareImageInput(messages, { inputBudget: 2048 }))).toBeLessThan(2048);
  });
  it('shares one budget between multiple images and leaves room for instructions and tools', async () => {
    const url = 'data:image/png;base64,' + original.toString('base64');
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: [
      { type: 'text', text: 'Keep this instruction. '.repeat(100) },
      ...Array.from({ length: 6 }, () => ({ type: 'image_url' as const, image_url: { url } })),
    ] }];
    const tools: OpenAI.ChatCompletionFunctionTool[] = [{ type: 'function', function: {
      name: 'read_resource', description: 'Read the original image.', parameters: { type: 'object' },
    } }];
    const wire = await prepareImageInput(messages, { inputBudget: 4096, tools });
    expect(estimateWireInputTokens(wire, tools)).toBeLessThan(4096);
    expect(wire[0].content?.[0]).toEqual(messages[0].content?.[0]);
  });
  it('does not treat a textual data URL as a native image', async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'data:image/png;base64,' + original.toString('base64') }];
    expect(await prepareImageInput(messages, { inputBudget: 100 })).toBe(messages);
    expect(estimateWireInputTokens(messages)).toBeGreaterThan(100);
  });
  it('pages out the older overview after a crop when a tiny window cannot afford both image encoders', async () => {
    const url = 'data:image/png;base64,' + original.toString('base64');
    const crop = 'data:image/png;base64,' + (await sharp(original).extract({ left: 80, top: 80, width: 800, height: 200 }).png().toBuffer()).toString('base64');
    const source: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'Read the original code.' }, { type: 'image_url', image_url: { url } }] },
      { role: 'user', content: [{ type: 'text', text: 'Requested crop.' }, { type: 'image_url', image_url: { url: crop } }] },
    ];
    const before = JSON.stringify(source);
    const wire = await prepareImageInput(source, { inputBudget: 1690,
      preserve: async value => value === url ? 'flujo://run/test/full-original' : 'flujo://run/test/crop' });
    expect(JSON.stringify(source)).toBe(before);
    const views = wire.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
    expect(views).toHaveLength(1);
    expect(JSON.stringify(wire[0])).toContain('flujo://run/test/full-original');
    expect(JSON.stringify(wire[1])).toContain('Requested crop.');
    expect(estimateWireInputTokens(wire)).toBeLessThan(1690);
  });
  it('never removes an image whose original could not be preserved', async () => {
    const url = 'data:image/png;base64,' + original.toString('base64');
    const source: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: [
      { type: 'image_url', image_url: { url } }, { type: 'image_url', image_url: { url } },
    ] }];
    const wire = await prepareImageInput(source, { inputBudget: 1690, preserve: async () => undefined });
    expect(wire.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : [])).toHaveLength(2);
  });
  it('stops preparation on cancellation before decoding', async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + original.toString('base64') } },
    ] }];
    await expect(prepareImageInput(messages, { shouldAbort: () => true })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
