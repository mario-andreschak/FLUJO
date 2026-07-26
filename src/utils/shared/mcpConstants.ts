/**
 * Shared MCP constants — framework-agnostic and dependency-light so they can be
 * imported from both the browser (e.g. flowValidation.ts) and the Node.js backend
 * (e.g. registry.ts) without pulling in server-only modules.
 */

/** Reserved names of FLUJO's built-in MCP servers. */
export const BUILTIN_SERVER_NAMES: readonly string[] = ['flujo', 'filesystem', 'bash'];

/**
 * Returns true when `name` is one of FLUJO's built-in server names.
 * Pure string check — no I/O.
 */
export function isBuiltInServerName(name: string): boolean {
  return BUILTIN_SERVER_NAMES.includes(name);
}
