import { normalizeStartRestrictions } from '@/shared/types/plannedExecution';

describe('planned execution start restriction normalization', () => {
  it('defaults new and legacy non-exclusive records to unrestricted', () => {
    expect(normalizeStartRestrictions({})).toEqual({
      startRestriction: 'unrestricted',
      superExclusive: false,
      emergency: false,
    });
    expect(normalizeStartRestrictions({ exclusive: false })).toEqual({
      startRestriction: 'unrestricted',
      superExclusive: false,
      emergency: false,
    });
  });

  it('preserves the historical combined behavior of legacy exclusive records', () => {
    expect(normalizeStartRestrictions({ exclusive: true })).toEqual({
      startRestriction: 'exclusive',
      superExclusive: true,
      emergency: false,
    });
  });

  it('lets canonical fields override the legacy compatibility flag', () => {
    expect(normalizeStartRestrictions({
      exclusive: true,
      startRestriction: 'singleton',
      superExclusive: false,
      emergency: true,
    })).toEqual({
      startRestriction: 'singleton',
      superExclusive: false,
      emergency: true,
    });
  });
});
