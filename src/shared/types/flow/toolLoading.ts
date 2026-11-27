/**
 * Process node settings for how MCP tools reach the model (#1448).
 * See docs/features/mcp-scoreboard/deferred-tools.md and code-mode.md.
 */

/**
 * `auto` (default): names first, full descriptions loaded on demand once they
 * would fill a noticeable share of the context window. `on-demand`: always.
 * `up-front`: every description on every turn.
 */
export const TOOL_LOADING_MODES = ['auto', 'on-demand', 'up-front'] as const;
export type ToolLoadingMode = (typeof TOOL_LOADING_MODES)[number];

/** Unknown or missing values mean `auto`, the default. */
export function normalizeToolLoadingMode(value: unknown): ToolLoadingMode {
  return TOOL_LOADING_MODES.includes(value as ToolLoadingMode) ? value as ToolLoadingMode : 'auto';
}

/** `auto` (default) offers code mode together with on-demand descriptions; `on` always; `off` never. */
export const CODE_MODE_SETTINGS = ['auto', 'on', 'off'] as const;
export type CodeModeSetting = (typeof CODE_MODE_SETTINGS)[number];

export function normalizeCodeModeSetting(value: unknown): CodeModeSetting {
  return CODE_MODE_SETTINGS.includes(value as CodeModeSetting) ? value as CodeModeSetting : 'auto';
}
