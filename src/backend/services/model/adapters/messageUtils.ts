import OpenAI from 'openai';

/**
 * Flatten an OpenAI message `content` value to plain text. Handles the string
 * form and the multi-part array form (keeping only text parts; non-text parts
 * such as images are dropped, since the native adapters here are text+tools).
 */
export function extractText(
  content: OpenAI.ChatCompletionMessageParam['content']
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is OpenAI.ChatCompletionContentPartText =>
        !!part && (part as { type?: string }).type === 'text'
      )
      .map(part => part.text)
      .join('');
  }
  return '';
}

/** Safely JSON-parse a tool-call arguments string, defaulting to `{}`. */
export function parseToolArgs(argsString: string | undefined): Record<string, unknown> {
  if (!argsString) return {};
  try {
    const parsed = JSON.parse(argsString);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
