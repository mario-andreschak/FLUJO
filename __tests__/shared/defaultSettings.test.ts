import { createDefaultSettings } from '@/shared/config/defaultSettings';

describe('fresh-install settings', () => {
  it('holds no feature switches (#1449)', () => {
    expect(createDefaultSettings().experimental).toEqual({});
  });

  it('returns independent settings objects', () => {
    const first = createDefaultSettings();
    const second = createDefaultSettings();

    expect(first).not.toBe(second);
    expect(first.experimental).not.toBe(second.experimental);
  });
});
