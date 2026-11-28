import { createDefaultSettings } from '@/shared/config/defaultSettings';

describe('fresh-install settings', () => {
  it('holds no feature switches, only the values still pinned for the #571 split (#1449)', () => {
    expect(createDefaultSettings().experimental).toEqual({
      claudeSessionResume: true,
      autoUnloadOllamaModels: true,
    });
  });

  it('returns independent settings objects', () => {
    const first = createDefaultSettings();
    const second = createDefaultSettings();

    expect(first).not.toBe(second);
    expect(first.experimental).not.toBe(second.experimental);
  });
});
