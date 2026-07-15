/**
 * Pure evaluator tests for Tier 2b edge conditions
 * (src/utils/shared/edgeConditions.ts).
 *
 * evaluateCondition must be total (never throw): an invalid regex or unknown
 * kind degrades to "no match" so a typo in a predicate can never crash a run.
 * selectConditionText picks the message text a predicate tests.
 */
import {
  evaluateCondition,
  selectConditionText,
  messageText,
  isRegexCompilable,
  isValidConditionKind,
  EdgeCondition,
} from '@/utils/shared/edgeConditions';

describe('evaluateCondition — contains', () => {
  it('matches a substring, case-sensitive by default', () => {
    expect(evaluateCondition({ kind: 'contains', value: 'FAIL' }, 'tests FAIL here')).toBe(true);
    expect(evaluateCondition({ kind: 'contains', value: 'FAIL' }, 'tests fail here')).toBe(false);
  });

  it('honors ignoreCase', () => {
    expect(evaluateCondition({ kind: 'contains', value: 'FAIL', ignoreCase: true }, 'all fail')).toBe(true);
  });

  it('honors negate', () => {
    expect(evaluateCondition({ kind: 'contains', value: 'FAIL', negate: true }, 'PASS')).toBe(true);
    expect(evaluateCondition({ kind: 'contains', value: 'FAIL', negate: true }, 'FAIL')).toBe(false);
  });
});

describe('evaluateCondition — equals', () => {
  it('requires the whole string to match', () => {
    expect(evaluateCondition({ kind: 'equals', value: 'PASS' }, 'PASS')).toBe(true);
    expect(evaluateCondition({ kind: 'equals', value: 'PASS' }, 'PASS.')).toBe(false);
  });

  it('honors ignoreCase and negate', () => {
    expect(evaluateCondition({ kind: 'equals', value: 'pass', ignoreCase: true }, 'PASS')).toBe(true);
    expect(evaluateCondition({ kind: 'equals', value: 'PASS', negate: true }, 'FAIL')).toBe(true);
  });
});

describe('evaluateCondition — regex', () => {
  it('matches by pattern', () => {
    expect(evaluateCondition({ kind: 'regex', value: '^PASS\\b' }, 'PASS 12 tests')).toBe(true);
    expect(evaluateCondition({ kind: 'regex', value: 'FAIL|ERROR' }, 'nothing here')).toBe(false);
  });

  it('honors ignoreCase via the regex i flag (JS has no (?i) inline flags)', () => {
    expect(evaluateCondition({ kind: 'regex', value: 'fail', ignoreCase: true }, 'FAIL')).toBe(true);
    expect(evaluateCondition({ kind: 'regex', value: 'fail' }, 'FAIL')).toBe(false);
  });

  it('an invalid pattern degrades to no-match and never throws (negate not applied)', () => {
    expect(() => evaluateCondition({ kind: 'regex', value: '[unterminated' }, 'anything')).not.toThrow();
    expect(evaluateCondition({ kind: 'regex', value: '[unterminated' }, 'anything')).toBe(false);
    // Even with negate, a broken predicate must not route.
    expect(evaluateCondition({ kind: 'regex', value: '[unterminated', negate: true }, 'anything')).toBe(false);
  });
});

describe('evaluateCondition — edge inputs', () => {
  it('unknown kind never matches', () => {
    expect(evaluateCondition({ kind: 'nope' as any, value: 'x' }, 'x')).toBe(false);
  });

  it('empty / null / undefined message never throws and does not match a non-empty value', () => {
    expect(evaluateCondition({ kind: 'contains', value: 'x' }, '')).toBe(false);
    expect(evaluateCondition({ kind: 'contains', value: 'x' }, null)).toBe(false);
    expect(evaluateCondition({ kind: 'contains', value: 'x' }, undefined)).toBe(false);
  });

  it('null/undefined condition never matches', () => {
    expect(evaluateCondition(null, 'x')).toBe(false);
    expect(evaluateCondition(undefined, 'x')).toBe(false);
  });

  it('an empty "contains" value matches any string', () => {
    expect(evaluateCondition({ kind: 'contains', value: '' }, 'anything')).toBe(true);
  });
});

describe('selectConditionText', () => {
  const messages = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'working...' },
    { role: 'tool', content: 'tool result: FAIL' },
  ];

  it('defaults to the last assistant message', () => {
    expect(selectConditionText(messages)).toBe('working...');
    expect(selectConditionText(messages, 'last-assistant')).toBe('working...');
  });

  it('last-message picks the most recent message of any role', () => {
    expect(selectConditionText(messages, 'last-message')).toBe('tool result: FAIL');
  });

  it('returns null when there is no assistant message', () => {
    expect(selectConditionText([{ role: 'user', content: 'hi' }], 'last-assistant')).toBeNull();
  });

  it('returns null for empty / missing message lists', () => {
    expect(selectConditionText([])).toBeNull();
    expect(selectConditionText(undefined)).toBeNull();
    expect(selectConditionText(null)).toBeNull();
  });

  it('extracts text from array (multi-part) content', () => {
    const parts = [
      { role: 'assistant', content: [{ type: 'text', text: 'part-a ' }, { type: 'text', text: 'part-b' }] },
    ];
    expect(selectConditionText(parts as any)).toBe('part-a part-b');
  });
});

describe('helpers', () => {
  it('messageText coerces content shapes', () => {
    expect(messageText('plain')).toBe('plain');
    expect(messageText([{ type: 'text', text: 'a' }, { type: 'image_url' }])).toBe('a');
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
    expect(messageText(42)).toBe('');
  });

  it('isRegexCompilable', () => {
    expect(isRegexCompilable('a.*b')).toBe(true);
    expect(isRegexCompilable('[bad')).toBe(false);
  });

  it('isValidConditionKind', () => {
    expect(isValidConditionKind('contains')).toBe(true);
    expect(isValidConditionKind('regex')).toBe(true);
    expect(isValidConditionKind('equals')).toBe(true);
    expect(isValidConditionKind('switch')).toBe(false);
    expect(isValidConditionKind(undefined)).toBe(false);
  });

  it('EdgeCondition is structurally usable', () => {
    const c: EdgeCondition = { kind: 'contains', value: 'x', target: 'last-message', ignoreCase: true, negate: true };
    expect(c.kind).toBe('contains');
  });
});
