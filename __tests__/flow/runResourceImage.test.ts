import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { writeRunResource, _setRunResourcesDirForTests, _clearRunResourceSettingsCache } from '@/backend/services/runResources';
import { executeRunResourceTool, nativeRunResourceResult } from '@/backend/execution/flow/handlers/runResourceTools';
import type { RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'), loadItem: jest.fn(async (_key, defaults) => defaults),
}));
let directory: string, previous: string, entry: RunResourceEntry;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-image-region-'));
  const nested = path.join(directory, 'a'.repeat(100), 'b'.repeat(100));
  await fs.mkdir(nested, { recursive: true });
  previous = _setRunResourcesDirForTests(nested); _clearRunResourceSettingsCache();
  const bytes = await sharp({ create: { width: 7680, height: 4320, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from('<svg width="7680" height="4320"><rect x="100" y="100" width="300" height="300" fill="red"/></svg>') }]).png().toBuffer();
  entry = await writeRunResource({ conversationId: 'image-reader', name: 'original', kind: 'image',
    mimeType: 'image/png', data: { base64: bytes.toString('base64') }, producedBy: { source: 'image-input' } }) as RunResourceEntry;
});
afterAll(async () => {
  _setRunResourcesDirForTests(previous); _clearRunResourceSettingsCache();
  await fs.rm(directory, { recursive: true, force: true });
});
it('delivers bounded native pixels from an exact region of the original 8K image', async () => {
  const outcome = await executeRunResourceTool('read_resource', { uri: entry.uri,
    image_region: { left: 150, top: 150, width: 200, height: 200 }, expected_sha256: entry.sha256,
  }, { conversationId: 'image-reader', maxImageTokens: 256 });
  expect(outcome.success).toBe(true);
  expect(outcome.data).toMatchObject({ imageView: { originalWidth: 7680, originalHeight: 4320 } });
  expect(outcome.data).toMatchObject({ uri: entry.uri, sha256: entry.sha256 });
  expect(outcome.data).not.toHaveProperty('localPath');
  expect(outcome.data).not.toHaveProperty('content');
  expect(JSON.stringify(outcome.data).length).toBeLessThan(400);
  const pixels = Buffer.from(outcome.media![0].data!, 'base64');
  const decoded = await sharp(pixels).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([...decoded.data.subarray(0, 3)]).toEqual([255, 0, 0]);
  expect(Math.ceil(decoded.info.width / 32) * Math.ceil(decoded.info.height / 32) * 3).toBeLessThanOrEqual(256);
  expect(nativeRunResourceResult(outcome)).toMatchObject({ content: [expect.objectContaining({ type: 'text' }),
    expect.objectContaining({ type: 'image', data: outcome.media![0].data })] });
});
it('rejects a foreign conversation, invalid crop and mismatching digest before delivering pixels', async () => {
  for (const [args, conversationId] of [
    [{ uri: entry.uri }, 'other'],
    [{ uri: entry.uri, image_region: { left: 7679, top: 0, width: 20, height: 20 } }, 'image-reader'],
    [{ uri: entry.uri, expected_sha256: '0'.repeat(64) }, 'image-reader'],
  ] as const) {
    const result = await executeRunResourceTool('read_resource', args, { conversationId });
    expect(result.success).toBe(false); expect(result.media).toBeUndefined();
  }
});
