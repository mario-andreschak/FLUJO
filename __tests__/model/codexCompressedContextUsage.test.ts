import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { constants as zstdConstants, zstdCompressSync } from 'node:zlib';
import { parseCodexTokenSnapshot, readCodexTokenSnapshot } from '@/backend/services/model/adapters/codexContextUsage';
import { subtractKnownCodexUsage } from '@/backend/services/model/adapters/codexUsage';

const id = '01a134b9-fea0-7941-a11a-123456789abc';
const snapshotLine = (input: number, output: number, context: number) => JSON.stringify({
  timestamp: '2026-10-13T10:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: input / 2,
      cache_write_input_tokens: 0, reasoning_output_tokens: output / 2 },
    last_token_usage: { input_tokens: context, output_tokens: output / 2, total_tokens: context + output / 2 },
    model_context_window: 200000,
  } },
}) + '\n';

describe('shipping Zstandard rollout representation', () => {
  let home: string;
  let plain: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-compressed-context-'));
    const directory = path.join(home, 'sessions/2026/10/13');
    await fs.mkdir(directory, { recursive: true });
    plain = path.join(directory, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
  });
  afterEach(async () => { jest.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

  it('reads cumulative/cache/reasoning totals separately from current context', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12) + snapshotLine(400, 40, 24)));
    const result = await readCodexTokenSnapshot(home, id);
    expect(result?.totalUsage).toEqual({ input_tokens: 400, output_tokens: 40, cached_input_tokens: 200,
      cache_write_input_tokens: 0, reasoning_output_tokens: 20 });
    expect(result?.contextUsage.totalTokens).toBe(44);
    expect(result?.contextUsage.contextWindowSource).toBe('runtime');
  });

  it('counts only the resumed increment from the compressed baseline', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12)));
    const before = await readCodexTokenSnapshot(home, id);
    await fs.writeFile(plain, snapshotLine(400, 40, 24));
    const after = await readCodexTokenSnapshot(home, id);
    expect(subtractKnownCodexUsage(after!.totalUsage, before!.totalUsage)).toEqual({ input_tokens: 300,
      output_tokens: 20, cached_input_tokens: 150, cache_write_input_tokens: 0, reasoning_output_tokens: 10 });
    expect(after?.contextUsage.totalTokens).toBe(44);
  });

  it('keeps resumed accounting unknown when corrupt storage provides no baseline', async () => {
    await fs.writeFile(plain + '.zst', Buffer.from('corrupt'));
    const before = await readCodexTokenSnapshot(home, id);
    expect(subtractKnownCodexUsage({ input_tokens: 400, output_tokens: 40 }, before?.totalUsage)).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: 400, output_tokens: 40 }, undefined)).toBeUndefined();
  });

  it.each(['plain', 'compressed', 'plain without newline'])('does not fall back past a completed invalid latest token event (%s)', async (format) => {
    const invalid = JSON.parse(snapshotLine(200, 40, 24));
    invalid.payload.info.last_token_usage.total_tokens = 1;
    let body = snapshotLine(100, 20, 12) + JSON.stringify(invalid) + '\n';
    if (format === 'plain without newline') body = body.slice(0, -1);
    const isPlain = format.startsWith('plain');
    await fs.writeFile(isPlain ? plain : plain + '.zst', isPlain ? body : zstdCompressSync(body));
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('retains a valid previous event during a partial plain token-event write', async () => {
    const partial = snapshotLine(200, 40, 24).slice(0, -45);
    await fs.writeFile(plain, snapshotLine(100, 20, 12) + partial);
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(100);
  });

  it('does not clamp regressed or incomplete counters into fabricated zero increments', () => {
    const baseline = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50, reasoning_output_tokens: 10 };
    expect(subtractKnownCodexUsage({ input_tokens: 80, output_tokens: 40, cached_input_tokens: 50, reasoning_output_tokens: 20 }, baseline)).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: 400, output_tokens: 40 }, baseline)).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: 400, output_tokens: 40, cached_input_tokens: 401, reasoning_output_tokens: 20 }, baseline)).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: 400, output_tokens: 40, cached_input_tokens: 50 }, { input_tokens: 100, output_tokens: 20 })).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: 101, output_tokens: 40, cached_input_tokens: 100 },
      { input_tokens: 100, output_tokens: 20, cached_input_tokens: 0 })).toBeUndefined();
    expect(subtractKnownCodexUsage({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 0 })).toBeUndefined();
  });

  it('rejects overflowing or inconsistent current-context totals', () => {
    const inconsistent = JSON.parse(snapshotLine(100, 20, 12));
    inconsistent.payload.info.last_token_usage.total_tokens = 10;
    expect(parseCodexTokenSnapshot(JSON.stringify(inconsistent))).toBeUndefined();
    const overflow = JSON.parse(snapshotLine(100, 20, 12));
    overflow.payload.info.last_token_usage.input_tokens = Number.MAX_SAFE_INTEGER;
    Reflect.deleteProperty(overflow.payload.info.last_token_usage, 'total_tokens');
    expect(parseCodexTokenSnapshot(JSON.stringify(overflow))).toBeUndefined();
  });

  it('follows cached plain-to-compressed-to-materialized transitions and prefers the current plain sibling', async () => {
    await fs.writeFile(plain, snapshotLine(100, 20, 12));
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(100);
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(200, 40, 24)));
    await fs.unlink(plain);
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(200);
    await fs.writeFile(plain, snapshotLine(300, 60, 36));
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(300);
    await fs.unlink(plain + '.zst');
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(300);
  });

  it('re-resolves a compression rename between lookup and descriptor open', async () => {
    await fs.writeFile(plain, snapshotLine(100, 20, 12));
    const open = fs.open.bind(fs);
    let moved = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === plain && !moved) {
        moved = true;
        await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12)));
        await fs.unlink(plain);
      }
      return open(...args);
    });
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(100);
    expect(moved).toBe(true);
  });

  it('retains the last bounded tail after a large decoded transcript', async () => {
    const body = JSON.stringify({ type: 'response_item', payload: 'x'.repeat(10 * 1024 * 1024) }) + '\n';
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12) + body + snapshotLine(200, 40, 24)));
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(200);
  });

  it('returns unknown when the token record is outside the retained decoded tail', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12) + 'x'.repeat(9 * 1024 * 1024) + '\n'));
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it.each(['not-zstd', 'truncated-frame', 'incomplete-json', 'invalid-latest-token'])('returns unknown for %s instead of an earlier total', async (kind) => {
    const valid = zstdCompressSync(snapshotLine(100, 20, 12));
    const bytes = kind === 'not-zstd' ? Buffer.from(snapshotLine(100, 20, 12))
      : kind === 'truncated-frame' ? valid.subarray(0, valid.length - 1)
      : kind === 'incomplete-json' ? zstdCompressSync(snapshotLine(100, 20, 12) + '{"type":"event_msg"')
      : zstdCompressSync(snapshotLine(100, 20, 12) + '{"type":"event_msg","payload":{"type":"token_count","info":{}}}\n');
    await fs.writeFile(plain + '.zst', bytes);
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('refuses excess compressed input before starting a decoder', async () => {
    await fs.writeFile(plain + '.zst', Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('refuses a decoded-size bomb without exposing its early token record', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12) + 'x'.repeat(64 * 1024 * 1024)));
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('refuses an oversized native decode window independently of decoded length', async () => {
    const body = snapshotLine(100, 20, 12) + 'x'.repeat(10 * 1024 * 1024) + '\n';
    const bytes = zstdCompressSync(body, { params: {
      [zstdConstants.ZSTD_c_windowLog]: 24, [zstdConstants.ZSTD_c_contentSizeFlag]: 0,
    } });
    await fs.writeFile(plain + '.zst', bytes);
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('rejects invalid decoded UTF-8 rather than accepting a preceding total', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(Buffer.concat([Buffer.from(snapshotLine(100, 20, 12)), Buffer.from([255, 10])])));
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('switches to a new materialized plain file after a compressed descriptor was opened', async () => {
    await fs.writeFile(plain + '.zst', zstdCompressSync(snapshotLine(100, 20, 12)));
    const open = fs.open.bind(fs);
    let materialized = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === plain + '.zst' && !materialized) {
        materialized = true;
        await fs.writeFile(plain, snapshotLine(200, 40, 24));
      }
      return handle;
    });
    expect((await readCodexTokenSnapshot(home, id))?.totalUsage.input_tokens).toBe(200);
    expect(materialized).toBe(true);
  });

  it('does not read a symlinked rollout or a linked sessions directory', async () => {
    const outside = path.join(home, 'outside');
    await fs.mkdir(outside);
    const target = path.join(outside, 'other.jsonl');
    await fs.writeFile(target, snapshotLine(100, 20, 12));
    if (process.platform !== 'win32') {
      await fs.symlink(target, plain + '.zst');
      expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
    }
    await fs.rm(path.join(home, 'sessions'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
  });

  it('rejects a cached regular file replaced by an outside symlink', async () => {
    await fs.writeFile(plain, snapshotLine(100, 20, 12));
    expect(await readCodexTokenSnapshot(home, id)).toBeDefined();
    await fs.unlink(plain);
    if (process.platform !== 'win32') {
      const outside = path.join(home, 'outside.jsonl');
      await fs.writeFile(outside, snapshotLine(800, 80, 80));
      await fs.symlink(outside, plain);
      expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
    } else {
      await fs.mkdir(plain);
      expect(await readCodexTokenSnapshot(home, id)).toBeUndefined();
    }
  });
});
