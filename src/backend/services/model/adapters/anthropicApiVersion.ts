/**
 * The Claude API version that `@anthropic-ai/sdk` 1.x sends with every request.
 * Requests FLUJO writes by hand (the model list) send the same one, so both
 * paths follow the same request rules.
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/**
 * The version before {@link ANTHROPIC_API_VERSION}. FLUJO sends it only to an
 * Anthropic-compatible server that refuses the current version; the requests
 * FLUJO builds are valid under both.
 */
export const ANTHROPIC_PREVIOUS_API_VERSION = '2023-06-01';

/**
 * Request fields that API version 2026-10-21 refuses with a 400 on every
 * model. FLUJO never sends them through the Anthropic Messages format.
 */
export const ANTHROPIC_REMOVED_SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k'] as const;
