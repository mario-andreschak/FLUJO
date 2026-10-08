export const MODEL_TURN_TEXT_PAGE_CHARS = 64 * 1024;
const TOKEN_CHARS = 4096;
type ValueToken = { value: unknown; depth: number };

function* quoted(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + TOKEN_CHARS, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield JSON.stringify(value.slice(start, end)).slice(1, -1);
    start = end;
  }
  yield '"';
}

/** Archived values are JSON data. Traverse lazily without copying whole strings,
 * collecting wide property lists, or recursively overflowing a deep call stack. */
function* tokens(value: unknown, depth: number): Generator<string | ValueToken> {
  if (typeof value === 'string') { yield* quoted(value); return; }
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value) ?? 'null';
    return;
  }
  const array = Array.isArray(value);
  yield array ? '[' : '{';
  let first = true;
  const indent = ' '.repeat(Math.min((depth + 1) * 2, 256));
  const entry = function* (child: unknown, key?: string): Generator<string | ValueToken> {
    yield (first ? '\n' : ',\n') + indent;
    first = false;
    if (key !== undefined) { yield* quoted(key); yield ': '; }
    yield { value: child, depth: depth + 1 };
  };
  if (array) {
    for (let i = 0; i < value.length; i++) yield* entry(value[i]);
  } else {
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      yield* entry(child, key);
    }
  }
  if (!first) yield '\n' + ' '.repeat(Math.min(depth * 2, 256));
  yield array ? ']' : '}';
}

export function modelTurnJsonPage(value: unknown, page: number): { text: string; hasNext: boolean } {
  if (!Number.isSafeInteger(page) || page < 0) throw new RangeError('Invalid inspector page');
  if (value === undefined) return { text: '', hasNext: false };
  const start = page * MODEL_TURN_TEXT_PAGE_CHARS;
  const end = start + MODEL_TURN_TEXT_PAGE_CHARS;
  if (typeof value === 'string') return { text: value.slice(start, end), hasNext: value.length > end };
  let offset = 0;
  const parts: string[] = [];
  const stack = [tokens(value, 0)];
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if (typeof next.value !== 'string') { stack.push(tokens(next.value.value, next.value.depth)); continue; }
    const token = next.value;
    const following = offset + token.length;
    if (following > start && offset < end) parts.push(token.slice(Math.max(0, start - offset), end - offset));
    if (following > end) return { text: parts.join(''), hasNext: true };
    offset = following;
  }
  return { text: parts.join(''), hasNext: false };
}
