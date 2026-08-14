/** Turn internal tool identifiers into compact labels suitable for chat UI. */
export function formatChainToolName(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/^mcp__/, '')
    .replace(/__/g, ' · ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
