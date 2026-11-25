/**
 * Tool result size limit (issue #1226): the one rule every tool-result path
 * uses to decide what moves to a run resource, plus the checks the Settings
 * page and its API apply to what a person types.
 */
import {
  autoToolResultBytes,
  kilobytesToToolResultBytes,
  normalizeRunResourceSettings,
  resolveToolResultBound,
  toolResultBytesToKilobytes,
  toolResultLimitSettings,
  toolResultSafetyBytes,
  validateToolResultLimitPatch,
} from '@/shared/toolResultLimit';
import { DEFAULT_RUN_RESOURCE_SETTINGS, type RunResourceSettings } from '@/shared/types/runResources';

const on = (extra: Partial<RunResourceSettings> = {}): RunResourceSettings => ({
  ...DEFAULT_RUN_RESOURCE_SETTINGS, toolResultTruncationEnabled: true, ...extra,
});

describe('resolveToolResultBound', () => {
  it('is off by default and then only applies the safety ceiling (half the window, no line limit)', () => {
    expect(DEFAULT_RUN_RESOURCE_SETTINGS.toolResultTruncationEnabled).toBe(false);
    expect(resolveToolResultBound(DEFAULT_RUN_RESOURCE_SETTINGS, 200_000)).toEqual({
      maxBytes: 400_000, maxLines: 0, reason: 'safety', safetyBytes: 400_000, contextWindow: 200_000, contextWindowKnown: true,
    });
  });

  it('assumes a 128K-token window when the model does not state one', () => {
    for (const window of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bound = resolveToolResultBound(DEFAULT_RUN_RESOURCE_SETTINGS, window);
      expect(bound).toMatchObject({ maxBytes: 256 * 1024, contextWindow: 131_072, contextWindowKnown: false });
    }
  });

  it('automatic: an eighth of the window, at least 16 KiB, scaling with the model', () => {
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'auto' }), 200_000))
      .toMatchObject({ maxBytes: 100_000, maxLines: 10_000, reason: 'limit' });
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'auto' }), 1_000_000).maxBytes).toBe(500_000);
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'auto' })).maxBytes).toBe(64 * 1024);
    // A 32K window would give 16,000 bytes; the floor keeps results useful.
    expect(autoToolResultBytes(32_000)).toBe(16 * 1024);
  });

  it('automatic never exceeds the safety ceiling on a tiny window', () => {
    // 4,000 tokens: safety is 8,000 bytes, below the 16 KiB floor.
    expect(toolResultSafetyBytes(4_000)).toBe(8_000);
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'auto' }), 4_000)).toMatchObject({ maxBytes: 8_000, reason: 'limit' });
    expect(toolResultSafetyBytes(1)).toBe(4 * 1024);
  });

  it('custom: uses the bytes and lines the person chose', () => {
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'custom', toolResultMaxBytes: 50 * 1024, toolResultMaxLines: 300 }), 200_000))
      .toMatchObject({ maxBytes: 50 * 1024, maxLines: 300, reason: 'limit' });
  });

  it('custom: a limit larger than the model can take falls back to the safety ceiling', () => {
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'custom', toolResultMaxBytes: 10 * 1024 * 1024 }), 200_000))
      .toMatchObject({ maxBytes: 400_000, reason: 'safety' });
    // 0 switches the byte limit off; the ceiling stays.
    expect(resolveToolResultBound(on({ toolResultLimitMode: 'custom', toolResultMaxBytes: 0 }), 200_000))
      .toMatchObject({ maxBytes: 400_000, reason: 'safety' });
  });

  it('treats settings written before #1226 (no mode, bytes set) as custom', () => {
    expect(resolveToolResultBound({ toolResultTruncationEnabled: true, toolResultMaxBytes: 50_000 }, 200_000))
      .toMatchObject({ maxBytes: 50_000, reason: 'limit' });
    expect(resolveToolResultBound({ toolResultTruncationEnabled: true }, 200_000).maxBytes).toBe(100_000);
  });
});

describe('validateToolResultLimitPatch', () => {
  it('accepts a full valid change', () => {
    const body = { toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 2048, toolResultMaxLines: 0 };
    expect(validateToolResultLimitPatch(body)).toEqual({ ok: true, patch: body });
    expect(validateToolResultLimitPatch({})).toEqual({ ok: true, patch: {} });
  });

  it.each([
    [null, 'invalid-body', undefined],
    [[], 'invalid-body', undefined],
    [{ textThresholdChars: 1 }, 'unknown-field', 'textThresholdChars'],
    [{ toolResultTruncationEnabled: 'yes' }, 'invalid-enabled', 'toolResultTruncationEnabled'],
    [{ toolResultLimitMode: 'smart' }, 'invalid-mode', 'toolResultLimitMode'],
    [{ toolResultMaxBytes: 1023 }, 'invalid-size', 'toolResultMaxBytes'],
    [{ toolResultMaxBytes: 100 * 1024 * 1024 + 1 }, 'invalid-size', 'toolResultMaxBytes'],
    [{ toolResultMaxBytes: 2048.5 }, 'invalid-size', 'toolResultMaxBytes'],
    [{ toolResultMaxBytes: '2048' }, 'invalid-size', 'toolResultMaxBytes'],
    [{ toolResultMaxLines: -1 }, 'invalid-lines', 'toolResultMaxLines'],
    [{ toolResultMaxLines: 10_000_001 }, 'invalid-lines', 'toolResultMaxLines'],
  ])('refuses %j', (body, error, field) => {
    expect(validateToolResultLimitPatch(body)).toEqual({ ok: false, error, ...(field ? { field } : {}) });
  });
});

describe('units shown on the Settings page', () => {
  it('turns whole kilobytes into bytes and refuses anything else', () => {
    expect(kilobytesToToolResultBytes('1')).toBe(1024);
    expect(kilobytesToToolResultBytes(' 256 ')).toBe(256 * 1024);
    expect(kilobytesToToolResultBytes('102400')).toBe(100 * 1024 * 1024);
    for (const text of ['0', '102401', '1.5', '-3', '', 'abc', '1e3']) {
      expect(kilobytesToToolResultBytes(text)).toBeNull();
    }
  });

  it('shows bytes as whole kilobytes, never rounding a real limit down to 0', () => {
    expect(toolResultBytesToKilobytes(256 * 1024)).toBe(256);
    expect(toolResultBytesToKilobytes(100_000)).toBe(98);
    expect(toolResultBytesToKilobytes(1)).toBe(1);
  });
});

describe('normalizeRunResourceSettings', () => {
  it('fills defaults for a missing or broken file', () => {
    expect(normalizeRunResourceSettings(undefined)).toEqual(DEFAULT_RUN_RESOURCE_SETTINGS);
    expect(normalizeRunResourceSettings('broken')).toEqual(DEFAULT_RUN_RESOURCE_SETTINGS);
  });

  it('keeps a hand-set byte limit from before #1226 as a custom limit', () => {
    const settings = normalizeRunResourceSettings({ toolResultTruncationEnabled: true, toolResultMaxBytes: 50_000 });
    expect(settings).toMatchObject({ toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 50_000 });
  });

  it('replaces broken values instead of failing tool calls', () => {
    const settings = normalizeRunResourceSettings({
      toolResultTruncationEnabled: 'true', toolResultMaxBytes: 'big', toolResultMaxLines: -4, autoCaptureEnabled: false,
    });
    expect(settings).toMatchObject({
      toolResultTruncationEnabled: false, toolResultLimitMode: 'auto',
      toolResultMaxBytes: DEFAULT_RUN_RESOURCE_SETTINGS.toolResultMaxBytes,
      toolResultMaxLines: DEFAULT_RUN_RESOURCE_SETTINGS.toolResultMaxLines,
      autoCaptureEnabled: false,
    });
  });

  it('gives the Settings page exactly its four fields', () => {
    expect(toolResultLimitSettings({ toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 4096 })).toEqual({
      toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 4096, toolResultMaxLines: 10_000,
    });
  });
});
