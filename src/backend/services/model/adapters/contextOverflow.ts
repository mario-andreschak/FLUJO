/** Provider and SDK wording for "this request is longer than the context
 * window". Ordinary bad requests and rate limits must not match: a match lets
 * FLUJO retry once with a smaller history. */
export function isContextOverflowText(text: string): boolean {
  const haystack = text.toLowerCase();
  return haystack.includes('context_length_exceeded')
    || haystack.includes('prompt_too_long')
    || /\bprompt (?:is )?too long\b/.test(haystack)
    || haystack.includes('character transport budget')
    || haystack.includes('maximum context length')
    || haystack.includes('context length is')
    || haystack.includes('maximum context')
    || haystack.includes('reduce the length')
    || haystack.includes('too many tokens')
    || haystack.includes('exceeds the context')
    || haystack.includes('input_too_large')
    || haystack.includes('input exceeds the maximum length')
    || /(?:image|pixel|patch).{0,80}(?:too large|exceed|maximum|limit)/.test(haystack)
    || /(?:too many|maximum).{0,40}(?:pixels|patches)/.test(haystack);
}
