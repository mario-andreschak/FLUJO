import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mockStopRecording = jest.fn();
jest.mock('../../mcp-servers/browser/src/recording', () => ({
  stopRecording: (...args: unknown[]) => mockStopRecording(...args),
}));
jest.mock('../../mcp-servers/browser/src/runtime', () => ({
  BrowserMcpError: class extends Error {},
  timeoutMs: () => 2000,
  failureCategoryForCode: () => 'unexpected',
}));
jest.mock('../../mcp-servers/browser/src/resources', () => ({ BROWSER_APP_URI: 'ui://test/browser' }));
jest.mock('../../mcp-servers/browser/src/capture', () => ({}));
jest.mock('../../mcp-servers/browser/src/gateway', () => ({}));
import { browserCallTool } from '../../mcp-servers/browser/src/tools';

let root = '';
let outputPath = '';
const owner = 'inline-recording-owner';
const savedLimit = process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES;

beforeEach(async () => {
  mockStopRecording.mockReset();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-recording-inline-'));
  outputPath = path.join(root, 'video.webm');
  process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES = '4';
  await fs.writeFile(outputPath, 'WEBM');
  mockStopRecording.mockImplementation(async () => ({
    success: true, status: 'stopped', recordingId: 'inline-recording', outputPath,
    warnings: ['Existing recording warning.'],
  }));
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (savedLimit === undefined) delete process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES;
  else process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES = savedLimit;
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-recording-inline-')) {
    throw new Error('Unexpected inline recording fixture cleanup target.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function stop() {
  return browserCallTool('browser_record_stop', { recordingId: 'inline-recording', outputPath }, new AbortController().signal, owner);
}

function observeHandles() {
  const realOpen = fs.open.bind(fs);
  const reads: jest.SpyInstance[] = [];
  const closes: jest.SpyInstance[] = [];
  jest.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await realOpen(filename, flags, mode);
    reads.push(jest.spyOn(handle, 'read'));
    closes.push(jest.spyOn(handle, 'close'));
    return handle;
  });
  return {
    reads,
    expectClosed() {
      expect(closes).toHaveLength(1);
      expect(closes[0]).toHaveBeenCalledTimes(1);
    },
    async expectBounded(maximum: number) {
      const calls = reads.flatMap((read) => read.mock.calls);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(([, offset, length, position]) => offset + length <= maximum && position === offset)).toBe(true);
      const results = await Promise.all(reads.flatMap((read) => read.mock.results.map((result) => result.value)));
      expect(results.reduce((total, result) => total + result.bytesRead, 0)).toBeLessThanOrEqual(maximum);
    },
  };
}

it.each([['webm', 'video/webm'], ['MP4', 'video/mp4'], ['mov', 'video/quicktime']])(
  'inlines a stable %s through its descriptor and preserves MIME, URI, status and owner', async (extension, mimeType) => {
    const destination = path.join(root, `video.${extension}`);
    await fs.rename(outputPath, destination);
    outputPath = destination;
    const observed = observeHandles();
    const pathnameReads = jest.spyOn(fs, 'readFile');
    const result = await stop();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      success: true, status: 'stopped', recordingId: 'inline-recording', outputPath,
      warnings: ['Existing recording warning.'],
    });
    expect(result.content).toContainEqual({
      type: 'resource', resource: { uri: pathToFileURL(outputPath).href, mimeType, blob: Buffer.from('WEBM').toString('base64') },
    });
    expect(mockStopRecording).toHaveBeenCalledWith({ recordingId: 'inline-recording', sessionId: undefined, outputPath }, owner);
    expect(pathnameReads).not.toHaveBeenCalled();
    await observed.expectBounded(5);
    observed.expectClosed();
  },
);

it('retains the exact oversized warning without consuming any file bytes', async () => {
  await fs.appendFile(outputPath, 'MORE');
  const observed = observeHandles();
  const result = await stop();
  expect(result.content.some((item) => item.type === 'resource')).toBe(false);
  expect(result.structuredContent).toMatchObject({
    success: true, status: 'stopped', outputPath,
    warnings: ['Existing recording warning.', 'The 8-byte video is available at outputPath but was not inlined into MCP because it exceeds the 4-byte transport limit.'],
  });
  expect(observed.reads[0]).not.toHaveBeenCalled();
  observed.expectClosed();
});

it.each(['growth', 'identity-replacement', 'hardlink-replacement'] as const)(
  'omits inline content after %s between inspection and descriptor read', async (kind) => {
    const observed = observeHandles();
    const realLstat = fs.lstat.bind(fs);
    let mutated = false;
    jest.spyOn(fs, 'lstat').mockImplementation(async (filename, options) => {
      const stat = await realLstat(filename, options);
      if (String(filename) === outputPath && !mutated) {
        mutated = true;
        if (kind === 'growth') await fs.appendFile(outputPath, 'MORE');
        else {
          const replacement = path.join(root, 'replacement.webm');
          await fs.writeFile(replacement, 'OTHER_VIDEO');
          if (kind === 'hardlink-replacement') { await fs.unlink(outputPath); await fs.link(replacement, outputPath); }
          else await fs.rename(replacement, outputPath);
        }
      }
      return stat;
    });
    const result = await stop();
    expect(mutated).toBe(true);
    expect(result.content.some((item) => item.type === 'resource')).toBe(false);
    expect(result.structuredContent).toMatchObject({ success: true, status: 'stopped', outputPath });
    expect((result.structuredContent as { warnings: string[] }).warnings).toContain(expect.stringContaining('stable regular file'));
    await observed.expectBounded(5);
    observed.expectClosed();
  },
);

it('rejects a preexisting hardlink before consuming bytes', async () => {
  await fs.link(outputPath, path.join(root, 'alias.webm'));
  const observed = observeHandles();
  const result = await stop();
  expect(result.content.some((item) => item.type === 'resource')).toBe(false);
  expect(observed.reads[0]).not.toHaveBeenCalled();
  observed.expectClosed();
});

it.each(['unknown-identity', 'named-link'] as const)('rejects %s metadata before consuming bytes', async (kind) => {
  const observed = observeHandles();
  const realLstat = fs.lstat.bind(fs);
  jest.spyOn(fs, 'lstat').mockImplementation(async (filename, options) => {
    const stat = await realLstat(filename, options);
    if (String(filename) !== outputPath) return stat;
    // Emulate metadata unavailable on a platform or a leaf-following open;
    // the opened handle remains real and no symlink privilege is needed.
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
      kind === 'unknown-identity' ? { ino: BigInt(0) } : { isSymbolicLink: () => true });
  });
  const result = await stop();
  expect(result.content.some((item) => item.type === 'resource')).toBe(false);
  expect(observed.reads[0]).not.toHaveBeenCalled();
  observed.expectClosed();
});

it('handles partial descriptor reads without exceeding the admitted size plus one sentinel', async () => {
  const realOpen = fs.open.bind(fs);
  const closed = jest.fn();
  const lengths: number[] = [];
  let consumed = 0;
  jest.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await realOpen(filename, flags, mode);
    const realRead = handle.read.bind(handle);
    const realClose = handle.close.bind(handle);
    jest.spyOn(handle, 'read').mockImplementation(async (...args) => {
      const [buffer, offset, length, position] = args as unknown as [ReturnType<typeof Buffer.alloc>, number, number, number];
      lengths.push(offset + length);
      const result = await realRead(buffer, offset, Math.min(length, 1), position);
      consumed += result.bytesRead;
      return result;
    });
    jest.spyOn(handle, 'close').mockImplementation(async () => { closed(); await realClose(); });
    return handle;
  });
  const result = await stop();
  expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource' }));
  expect(lengths.length).toBeGreaterThan(1);
  expect(Math.max(...lengths)).toBeLessThanOrEqual(5);
  expect(consumed).toBe(4);
  expect(closed).toHaveBeenCalledTimes(1);
});

it('keeps the stopped result and closes the handle on a private read error', async () => {
  const realOpen = fs.open.bind(fs);
  const closed = jest.fn();
  jest.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
    const handle = await realOpen(filename, flags, mode);
    const realClose = handle.close.bind(handle);
    jest.spyOn(handle, 'read').mockRejectedValue(new Error('private-host-filesystem-detail'));
    jest.spyOn(handle, 'close').mockImplementation(async () => { closed(); await realClose(); });
    return handle;
  });
  const result = await stop();
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ success: true, status: 'stopped', outputPath });
  expect(result.content.some((item) => item.type === 'resource')).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private-host-filesystem-detail');
  expect(closed).toHaveBeenCalledTimes(1);
});

it.each(['empty', 'missing', 'directory'] as const)('retains a stopped %s recording without inline content', async (kind) => {
  if (kind === 'empty') await fs.truncate(outputPath, 0);
  else { await fs.unlink(outputPath); if (kind === 'directory') await fs.mkdir(outputPath); }
  const result = await stop();
  expect(result.structuredContent).toMatchObject({ success: true, status: 'stopped', outputPath });
  expect(result.content.some((item) => item.type === 'resource')).toBe(false);
});

it('preserves a recording service failure without attempting a file open', async () => {
  mockStopRecording.mockResolvedValue({ success: false, error: 'Recording was not owned by this session.' });
  const opened = jest.spyOn(fs, 'open');
  const result = await stop();
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ success: false, error: 'Recording was not owned by this session.' });
  expect(opened).not.toHaveBeenCalled();
});

it('preserves an active recording without attempting a file open', async () => {
  mockStopRecording.mockResolvedValue({ success: true, status: 'recording', outputPath });
  const opened = jest.spyOn(fs, 'open');
  expect((await stop()).structuredContent).toEqual({ success: true, status: 'recording', outputPath });
  expect(opened).not.toHaveBeenCalled();
});
