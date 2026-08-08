/**
 * Formats a JSON argument payload while it is still arriving from a model.
 *
 * The repaired value is display-only. Callers must retain and submit the raw
 * payload, because a syntactically valid preview may omit a trailing property.
 */
export interface PartialJsonFormat {
  text: string;
  complete: boolean;
}

function closePartialJson(raw: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') stack.pop();
  }

  let repaired = raw.trimEnd();
  // A dangling object key cannot be made into a value without inventing data.
  repaired = repaired.replace(/,?\\s*"(?:(?:\\\\.)|[^"\\\\])*"?\\s*:\\s*$/, '');
  if (inString) repaired += '"';
  return repaired + stack.reverse().join('');
}

/** Return pretty JSON when complete, or a best-effort preview while streaming. */
export function formatPartialJson(raw: string): PartialJsonFormat {
  try {
    return { text: JSON.stringify(JSON.parse(raw), null, 2), complete: true };
  } catch {
    const repaired = closePartialJson(raw);
    try {
      return { text: JSON.stringify(JSON.parse(repaired), null, 2), complete: false };
    } catch {
      return { text: raw, complete: false };
    }
  }
}
