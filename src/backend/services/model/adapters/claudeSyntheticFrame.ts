/**
 * Claude Code writes some assistant frames itself instead of the model: API
 * errors such as "Prompt is too long" or "Invalid API key", and notices such
 * as the output-token limit. They carry the model name `<synthetic>` or an
 * `error` code. Their text is a diagnostic, never the model's answer, and
 * their zero usage is not a model request.
 */
const SYNTHETIC_MODEL = '<synthetic>';

export function isClaudeSyntheticModel(model: unknown): boolean {
  return model === SYNTHETIC_MODEL;
}

/**
 * The diagnostic code of a frame Claude Code wrote itself, or undefined for a
 * model frame. A model frame cut at the output-token limit keeps its prose.
 */
export function claudeSyntheticFrameError(frame: { error?: unknown; message?: { model?: unknown } }): string | undefined {
  const error = typeof frame.error === 'string' && frame.error ? frame.error : undefined;
  if (isClaudeSyntheticModel(frame.message?.model)) return error ?? 'notice';
  return error && error !== 'max_output_tokens' ? error : undefined;
}
