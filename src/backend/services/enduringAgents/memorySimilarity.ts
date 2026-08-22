export type MemoryRelation = 'agree' | 'contradict' | 'unrelated';

export type MemoryRelationReason =
  | 'low_overlap'
  | 'high_overlap'
  | 'polarity_mismatch'
  | 'antonym_mismatch'
  | 'value_mismatch';

export interface MemoryRelationScore {
  relation: MemoryRelation;
  similarity: number;
  tokenJaccard: number;
  bigramDice: number;
  reason: MemoryRelationReason;
  detectorVersion: 'lexical-v1';
}

export interface MemoryRelationScorer {
  score(left: string, right: string, threshold: number): MemoryRelationScore;
}

const NEGATIONS = new Set([
  'no', 'not', 'never', 'none', 'neither', 'without',
  "isn't", "aren't", "wasn't", "weren't", "doesn't", "don't", "didn't",
  'cannot', "can't", "won't",
]);

const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['allow', 'deny'],
  ['allowed', 'denied'],
  ['enable', 'disable'],
  ['enabled', 'disabled'],
  ['increase', 'decrease'],
  ['increased', 'decreased'],
  ['open', 'closed'],
  ['present', 'absent'],
  ['required', 'optional'],
  ['true', 'false'],
  ['yes', 'no'],
];

const ANTONYMS = new Map<string, string>(
  ANTONYM_PAIRS.flatMap(([left, right]): [string, string][] => (
    [[left, right], [right, left]]
  )),
);
const ANTONYM_WORDS = new Set(ANTONYM_PAIRS.flat());

function normalizedTokens(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

function setScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter(value => right.has(value)).length;
  return intersection / (left.size + right.size - intersection);
}

function dice(left: readonly string[], right: readonly string[]): number {
  const leftBigrams = new Set(left.slice(0, -1).map((value, index) => `${value}\u0000${left[index + 1]}`));
  const rightBigrams = new Set(right.slice(0, -1).map((value, index) => `${value}\u0000${right[index + 1]}`));
  if (leftBigrams.size === 0 && rightBigrams.size === 0) {
    return left.length === right.length && left[0] === right[0] ? 1 : 0;
  }
  const intersection = [...leftBigrams].filter(value => rightBigrams.has(value)).length;
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

function factualValues(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/\b(?:\d{4}-\d{1,2}-\d{1,2}|\d+(?:[.,]\d+)?)\b/g) ?? [];
}

function hasAntonymMismatch(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some(token => {
    const opposite = ANTONYMS.get(token);
    return opposite !== undefined && right.has(opposite);
  });
}

function anchorTokens(tokens: readonly string[]): string[] {
  return tokens.filter(token => (
    !NEGATIONS.has(token)
    && !ANTONYM_WORDS.has(token)
    && !/^\d/.test(token)
  ));
}

export const lexicalRelationScorer: MemoryRelationScorer = {
  score(leftValue, rightValue, threshold) {
    const left = normalizedTokens(leftValue);
    const right = normalizedTokens(rightValue);
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    const tokenJaccard = setScore(leftSet, rightSet);
    const bigramDice = dice(left, right);
    const anchorJaccard = setScore(new Set(anchorTokens(left)), new Set(anchorTokens(right)));
    const similarity = Math.max(tokenJaccard, bigramDice, anchorJaccard);
    const boundedThreshold = Math.min(1, Math.max(0, threshold));

    const base = {
      similarity,
      tokenJaccard,
      bigramDice,
      detectorVersion: 'lexical-v1' as const,
    };
    if (similarity < boundedThreshold) {
      return { ...base, relation: 'unrelated', reason: 'low_overlap' };
    }

    const leftValues = factualValues(leftValue);
    const rightValues = factualValues(rightValue);
    if (
      leftValues.length > 0
      && rightValues.length > 0
      && JSON.stringify(leftValues) !== JSON.stringify(rightValues)
    ) {
      return { ...base, relation: 'contradict', reason: 'value_mismatch' };
    }

    const leftNegated = left.some(token => NEGATIONS.has(token));
    const rightNegated = right.some(token => NEGATIONS.has(token));
    if (leftNegated !== rightNegated) {
      return { ...base, relation: 'contradict', reason: 'polarity_mismatch' };
    }
    if (hasAntonymMismatch(leftSet, rightSet)) {
      return { ...base, relation: 'contradict', reason: 'antonym_mismatch' };
    }
    return { ...base, relation: 'agree', reason: 'high_overlap' };
  },
};
