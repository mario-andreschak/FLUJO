import {
  MAX_RENAME_ENTRIES,
  buildRenamePreview,
  compileRenameRule,
  effectiveName,
  validateRenameMap,
} from '@/utils/shared/packageRename';

const candidates = [
  { key: 'flow-a', original: 'Daily report' },
  { key: 'flow-b', original: 'Weekly report' },
];

describe('packageRename', () => {
  it('builds prefix and regex rename maps without changing stable keys', () => {
    expect(buildRenamePreview(candidates, { mode: 'prefix', prefix: 'Team: ' }).map).toEqual({
      'flow-a': 'Team: Daily report',
      'flow-b': 'Team: Weekly report',
    });

    expect(buildRenamePreview(candidates, {
      mode: 'regex', pattern: '^(Daily|Weekly) (.*)$', replacement: '$2 ($1)', caseInsensitive: true,
    }).map).toEqual({
      'flow-a': 'report (Daily)',
      'flow-b': 'report (Weekly)',
    });
  });

  it('reports malformed regular expressions instead of throwing', () => {
    expect(compileRenameRule({ mode: 'regex', pattern: '[' }).error).toBeTruthy();
    expect(buildRenamePreview(candidates, { mode: 'regex', pattern: '[' }).valid).toBe(false);
  });

  it('rejects case-insensitive duplicate and host-colliding bulk names', () => {
    const duplicates = buildRenamePreview(
      [{ key: 'a', original: 'one' }, { key: 'b', original: 'ONE' }],
      { mode: 'regex', pattern: '.+', replacement: 'Shared' },
    );
    expect(duplicates.valid).toBe(false);
    expect(duplicates.items[1].error).toMatch(/duplicate/i);

    const collision = buildRenamePreview(candidates, { mode: 'prefix', prefix: 'Team: ' }, {
      existingNames: [' team: daily report '],
    });
    expect(collision.valid).toBe(false);
    expect(collision.items[0].error).toMatch(/existing/i);
  });

  it('validates collisions across renamed and untouched candidates', () => {
    expect(validateRenameMap(
      { 'flow-a': 'Weekly report' },
      candidates,
      { label: 'flow' },
    )).toEqual([expect.stringMatching(/duplicate flow result/i)]);
  });

  it('validates request bounds and resolves effective names safely', () => {
    const oversized = Object.fromEntries(Array.from({ length: MAX_RENAME_ENTRIES + 1 }, (_, index) => [String(index), 'name']));
    expect(validateRenameMap(oversized, candidates)).toEqual([
      expect.stringMatching(/too many rename entries/i),
    ]);
    expect(effectiveName({ 'flow-a': 'Renamed' }, 'flow-a', 'Original')).toBe('Renamed');
    expect(effectiveName({ 'flow-a': '   ' }, 'flow-a', 'Original')).toBe('Original');
  });
});
