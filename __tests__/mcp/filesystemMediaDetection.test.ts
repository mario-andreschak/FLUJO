/**
 * Tests for media file detection in filesystem read_file tool (#365).
 *
 * These tests verify that the filesystem MCP server correctly detects
 * and returns media files (images, audio, video) as MCP media content items,
 * enabling same-turn vision access via the capture infrastructure.
 */
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn(),
}));

jest.mock('@modelcontextprotocol/ext-apps', () => ({
  LATEST_PROTOCOL_VERSION: '2026-01-26',
}));

import { loadServerRoots } from '@/backend/services/mcp/config';
import { filesystemCallTool } from '@/backend/services/mcp/internal/filesystemTools';
import { _clearTouchedFilesForTests } from '@/backend/services/mcp/internal/filesystemResources';

const mockedRoots = loadServerRoots as jest.Mock;

function getMediaContent(r: CallToolResult): { type: string; mimeType: string; data: string } {
  return r.content[0] as any;
}

function getStructured(r: CallToolResult): Record<string, unknown> | undefined {
  return (r as { structuredContent?: Record<string, unknown> }).structuredContent;
}

describe('filesystem media detection (#365)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'flujo-media-test-'));
    mockedRoots.mockResolvedValue([testDir]);
  });

  afterEach(async () => {
    _clearTouchedFilesForTests();
    await fsp.rm(testDir, { recursive: true, force: true });
  });

  it('detects and returns PNG images as image media content', async () => {
    // PNG magic bytes: 89 50 4E 47
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const filePath = path.join(testDir, 'test.png');
    await fsp.writeFile(filePath, pngData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/png');
    expect(content.data).toBeTruthy(); // base64 data present
    expect(getStructured(result)).toMatchObject({
      mediaType: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
    });
  });

  it('magic-detects extensionless PNG files above the large-text threshold', async () => {
    const pngData = Buffer.alloc(100_001);
    pngData.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filePath = path.join(testDir, 'extensionless-media');
    await fsp.writeFile(filePath, pngData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    expect(getMediaContent(result)).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect(getStructured(result)).toMatchObject({ size: pngData.length });
  });

  it('detects and returns JPEG images as image media content', async () => {
    // JPEG magic bytes: FF D8 FF
    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const filePath = path.join(testDir, 'test.jpg');
    await fsp.writeFile(filePath, jpegData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/jpeg');
  });

  it('detects and returns GIF images as image media content', async () => {
    // GIF magic bytes: 47 49 46 38 ('GIF8')
    const gifData = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
    const filePath = path.join(testDir, 'test.gif');
    await fsp.writeFile(filePath, gifData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/gif');
  });

  it('detects and returns WebP images as image media content', async () => {
    // WebP magic bytes: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP at offset 8)
    const webpData = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const filePath = path.join(testDir, 'test.webp');
    await fsp.writeFile(filePath, webpData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/webp');
  });

  it('detects and returns MP3 audio as audio media content', async () => {
    // MP3 magic bytes: FF FB (MPEG Layer 3 frame sync)
    const mp3Data = Buffer.from([0xff, 0xfb, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const filePath = path.join(testDir, 'test.mp3');
    await fsp.writeFile(filePath, mp3Data);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('audio');
    expect(content.mimeType).toBe('audio/mpeg');
  });

  it('detects and returns WAV audio as audio media content', async () => {
    // WAV magic bytes: 52 49 46 46 (RIFF) ... 57 41 56 45 (WAVE at offset 8)
    const wavData = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    const filePath = path.join(testDir, 'test.wav');
    await fsp.writeFile(filePath, wavData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('audio');
    expect(content.mimeType).toBe('audio/wav');
  });

  it('detects and returns WebM video as video media content', async () => {
    // WebM magic bytes: 1A 45 DF A3
    const webmData = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
    const filePath = path.join(testDir, 'test.webm');
    await fsp.writeFile(filePath, webmData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('video');
    expect(content.mimeType).toBe('video/webm');
  });

  it('detects and returns MP4 video as video media content', async () => {
    // MP4 magic bytes: 00 00 00 18 66 74 79 70 (at offset 4)
    const mp4Data = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    const filePath = path.join(testDir, 'test.mp4');
    await fsp.writeFile(filePath, mp4Data);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('video');
    expect(content.mimeType).toBe('video/mp4');
  });

  it('falls back to extension-based MIME type detection', async () => {
    // Unrecognized magic bytes but valid .png extension
    const unknownData = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const filePath = path.join(testDir, 'mystery.png');
    await fsp.writeFile(filePath, unknownData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    expect(result.isError).toBeUndefined();
    const content = getMediaContent(result);
    expect(content.type).toBe('image');
    expect(content.mimeType).toBe('image/png');
  });

  it('includes metadata in structured content', async () => {
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filePath = path.join(testDir, 'test.png');
    await fsp.writeFile(filePath, pngData);

    const result = await filesystemCallTool('read_file', { path: filePath });

    const structured = getStructured(result);
    expect(structured).toMatchObject({
      mediaType: 'image',
      mimeType: 'image/png',
      encoding: 'base64',
      size: expect.any(Number),
    });
    expect(structured?.size).toBe(pngData.length);
  });

  it('rejects pattern grep on media files', async () => {
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const filePath = path.join(testDir, 'test.png');
    await fsp.writeFile(filePath, pngData);

    // Attempt to grep for a pattern in a media file
    const result = await filesystemCallTool('read_file', { path: filePath, pattern: 'foo' });

    expect(result.isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/media, not text/i);
  });

  it('rejects line range reads on media files', async () => {
    const mp3Data = Buffer.from([0xff, 0xfb, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const filePath = path.join(testDir, 'test.mp3');
    await fsp.writeFile(filePath, mp3Data);

    // Attempt line-range read on media file
    const result = await filesystemCallTool('read_file', { path: filePath, from: 1, to: 10 });

    expect(result.isError).toBe(true);
  });
});
