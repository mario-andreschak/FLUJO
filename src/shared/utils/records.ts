/** A non-null object whose string keys can be read without asserting its shape. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** One property of any value, or undefined when the value is not an object. */
export function propertyOf(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
