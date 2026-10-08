import { createDefaultSettings } from '@/shared/config/defaultSettings';

describe('fresh-install settings', () => {
  it('enables the selected experimental features by default', () => {
    expect(createDefaultSettings().experimental).toEqual({
      enabled: true,
      claudeSessionResume: true,
      autoUnloadOllamaModels: true,
      compactionEnabled: true,
      subflowDetachedInvocation: true,
      subflowSessions: true,
    });
  });

  it('returns independent settings objects', () => {
    const first = createDefaultSettings();
    const second = createDefaultSettings();

    expect(first).not.toBe(second);
    expect(first.experimental).not.toBe(second.experimental);
  });
});
