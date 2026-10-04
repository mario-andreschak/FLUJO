import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

jest.mock('patchright', () => ({ chromium: { launch: jest.fn(), launchPersistentContext: jest.fn() } }));
jest.mock('../../mcp-servers/browser/src/recording', () => ({
  recordingStatus: jest.fn(), releaseRecordingsForOwner: jest.fn(),
  startRecording: jest.fn(), stopRecording: jest.fn(),
}));

import { stopRecording } from '../../mcp-servers/browser/src/recording';
import { browserCallTool } from '../../mcp-servers/browser/src/tools';
import { browserExtensions, shutdownBrowserRuntime } from '../../mcp-servers/browser/src/runtime';
import { readBoundedRegularFile } from '../../mcp-servers/browser/src/boundedFileRead';

const mockedStop = stopRecording as jest.MockedFunction<typeof stopRecording>;
const savedProfile = process.env.FLUJO_BROWSER_PROFILE_DIR;
const savedExtensions = process.env.FLUJO_BROWSER_EXTENSION_DIRS;
const savedInlineLimit = process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES;
const execFileAsync = promisify(execFile);

describe('browser file reads use the checked descriptor', () => {
  let parent: string;
  let fixture: string;

  beforeEach(async () => {
    parent = await fs.realpath(os.tmpdir());
    fixture = await fs.mkdtemp(path.join(parent, 'flujo-browser-file-reads-'));
    delete process.env.FLUJO_BROWSER_EXTENSION_DIRS;
    mockedStop.mockReset();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await shutdownBrowserRuntime();
    for (const [key, value] of [
      ['FLUJO_BROWSER_PROFILE_DIR', savedProfile],
      ['FLUJO_BROWSER_EXTENSION_DIRS', savedExtensions],
      ['FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES', savedInlineLimit],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const resolved = await fs.realpath(fixture);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('flujo-browser-file-reads-')) {
      throw new Error('Refusing cleanup outside the owned fixture.');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });

  async function swapAfterCheck(file: string, replacement: string) {
    let swapped = false;
    const swap = async () => {
      if (swapped) return;
      swapped = true;
      await fs.rename(file, `${file}.checked`);
      await fs.rename(replacement, file);
    };
    // Exercise the old path-stat boundary and the fixed descriptor-stat
    // boundary with the same real, entirely owned pathname replacement.
    const originalStat = fs.stat;
    jest.spyOn(fs, 'stat').mockImplementation((async (...args: unknown[]) => {
      const stat = await Reflect.apply(originalStat, fs, args);
      if (args[0] === file) await swap();
      return stat;
    }) as typeof fs.stat);
    const originalOpen = fs.open;
    jest.spyOn(fs, 'open').mockImplementation((async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args) as FileHandle;
      if (args[0] === file) {
        const handleStat = handle.stat.bind(handle);
        jest.spyOn(handle, 'stat').mockImplementation((async (...statArgs: unknown[]) => {
          const stat = await Reflect.apply(handleStat, handle, statArgs);
          await swap();
          return stat;
        }) as typeof handle.stat);
      }
      return handle;
    }) as typeof fs.open);
    return () => swapped;
  }

  it('inlines the checked recording rather than a larger replacement pathname', async () => {
    const file = path.join(fixture, 'recording.webm');
    const replacement = path.join(fixture, 'replacement.webm');
    await fs.writeFile(file, 'ORIGINAL');
    await fs.writeFile(replacement, 'LARGER REPLACEMENT SHOULD NOT BE INLINED');
    process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES = '8';
    mockedStop.mockResolvedValue({ success: true, status: 'stopped', outputPath: file });
    const swapped = await swapAfterCheck(file, replacement);
    const result = await browserCallTool('browser_record_stop', { recordingId: 'owned-test' }, new AbortController().signal);
    expect(swapped()).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.content.find(block => block.type === 'resource')).toMatchObject({
      resource: { mimeType: 'video/webm', blob: Buffer.from('ORIGINAL').toString('base64') },
    });
  });

  it('lists extensions from the checked preferences rather than its replacement', async () => {
    process.env.FLUJO_BROWSER_PROFILE_DIR = fixture;
    const folder = path.join(fixture, 'Default');
    await fs.mkdir(folder);
    const file = path.join(folder, 'Preferences');
    const replacement = path.join(folder, 'replacement');
    const preferences = (name: string) => JSON.stringify({
      extensions: { settings: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { state: 1, manifest: { name, version: '1' } } } },
    });
    await fs.writeFile(file, preferences('ORIGINAL'));
    await fs.writeFile(replacement, preferences('REPLACEMENT'));
    const swapped = await swapAfterCheck(file, replacement);
    const result = await browserExtensions();
    expect(swapped()).toBe(true);
    expect(result.installed).toEqual([
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'ORIGINAL', version: '1', enabled: true, source: 'profile' },
    ]);
  });

  it('bounds a recording that grows after its descriptor size check', async () => {
    const file = path.join(fixture, 'growing.webm');
    await fs.writeFile(file, 'ORIGINAL');
    process.env.FLUJO_BROWSER_INLINE_RECORDING_MAX_BYTES = '8';
    mockedStop.mockResolvedValue({ success: true, status: 'stopped', outputPath: file });
    const originalOpen = fs.open;
    let observedBytes = 0;
    let closed = false;
    jest.spyOn(fs, 'open').mockImplementation((async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args) as FileHandle;
      if (args[0] === file) {
        const originalStat = handle.stat.bind(handle);
        jest.spyOn(handle, 'stat').mockImplementation((async (...statArgs: unknown[]) => {
          const stat = await Reflect.apply(originalStat, handle, statArgs);
          await fs.appendFile(file, 'GROWTH'.repeat(20));
          return stat;
        }) as typeof handle.stat);
        const originalRead = handle.read.bind(handle);
        jest.spyOn(handle, 'read').mockImplementation((async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(originalRead, handle, readArgs);
          observedBytes += result.bytesRead;
          return result;
        }) as typeof handle.read);
        const originalClose = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => { closed = true; await originalClose(); });
      }
      return handle;
    }) as typeof fs.open);
    const result = await browserCallTool('browser_record_stop', { recordingId: 'owned-growing' }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content.some(block => block.type === 'resource')).toBe(false);
    expect(JSON.stringify(result)).toContain('exceeds the 8-byte transport limit');
    expect(observedBytes).toBe(9);
    expect(closed).toBe(true);
  });

  it.each([['missing'], ['empty'], ['directory']])('does not inline an unavailable %s file', async kind => {
    const file = path.join(fixture, kind);
    if (kind === 'empty') await fs.writeFile(file, '');
    if (kind === 'directory') await fs.mkdir(file);
    mockedStop.mockResolvedValue({ success: true, status: 'stopped', outputPath: file });
    const result = await browserCallTool('browser_record_stop', { recordingId: 'owned-unavailable' }, new AbortController().signal);
    expect(result.isError).toBeUndefined();
    expect(result.content.some(block => block.type === 'resource')).toBe(false);
  });

  it('accepts exact-limit bytes and excludes an already oversized file', async () => {
    const file = path.join(fixture, 'bounded.bin');
    await fs.writeFile(file, '12345678');
    expect(await readBoundedRegularFile(file, 8)).toEqual({ status: 'read', bytes: Buffer.from('12345678') });
    await fs.appendFile(file, '9');
    expect(await readBoundedRegularFile(file, 8)).toEqual({ status: 'too-large', size: 9 });
  });

  it('closes the descriptor when reading fails', async () => {
    const file = path.join(fixture, 'failure.bin');
    await fs.writeFile(file, 'owned');
    const originalOpen = fs.open;
    const readError = new Error('owned synthetic read failure');
    let closed = false;
    jest.spyOn(fs, 'open').mockImplementation((async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalOpen, fs, args) as FileHandle;
      jest.spyOn(handle, 'read').mockRejectedValueOnce(readError);
      const originalClose = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { closed = true; await originalClose(); });
      return handle;
    }) as typeof fs.open);
    await expect(readBoundedRegularFile(file, 8)).rejects.toBe(readError);
    expect(closed).toBe(true);
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt('rejects an actual FIFO through the compiled package (POSIX)', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--test', path.resolve('mcp-servers/browser/scripts/bounded-file-read.test.mjs'),
    ], { timeout: 12000 });
    expect(stdout).toContain('"kind":"real-fifo-admission"');
    expect(stdout).toContain('# pass 1');
    expect(stdout).toContain('# skipped 0');
  }, 15000);
});
