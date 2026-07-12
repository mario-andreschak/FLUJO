/**
 * The hardware→model suggestion is a pure function, so its thresholds can be
 * pinned directly. It is the load-bearing logic behind the onboarding's
 * "download & use" recommendation.
 */
import { suggestModel } from '@/backend/services/ollama/capability';

const GB = 1024 * 1024 * 1024;

describe('suggestModel', () => {
  it('suggests a tiny model on a low-RAM, CPU-only machine', () => {
    expect(suggestModel({ totalRamBytes: 6 * GB })).toBe('llama3.2:1b');
  });

  it('suggests a 3B model for 8–16 GB', () => {
    expect(suggestModel({ totalRamBytes: 12 * GB })).toBe('llama3.2:3b');
  });

  it('suggests a 7B model for 16–32 GB', () => {
    expect(suggestModel({ totalRamBytes: 24 * GB })).toBe('qwen2.5:7b');
  });

  it('suggests a larger model at 32 GB and above', () => {
    expect(suggestModel({ totalRamBytes: 64 * GB })).toBe('qwen2.5:14b');
  });

  it('is bound by GPU VRAM, not system RAM, when a GPU is present', () => {
    // Plenty of RAM, but a small 6 GB GPU is the real constraint.
    expect(suggestModel({ totalRamBytes: 64 * GB, vramBytes: 6 * GB })).toBe('llama3.2:1b');
  });

  it('ignores a zero/absent VRAM value and falls back to RAM', () => {
    expect(suggestModel({ totalRamBytes: 24 * GB, vramBytes: 0 })).toBe('qwen2.5:7b');
    expect(suggestModel({ totalRamBytes: 24 * GB, vramBytes: null })).toBe('qwen2.5:7b');
  });
});
