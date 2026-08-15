/**
 * Stable identity for FLUJO's in-process Persona memory provider.
 *
 * The default provider does not require a transport process, but it deliberately
 * uses an MCP-shaped server/tool identity so authored Flows, execution traces,
 * and a future external provider adapter share one explicit contract.
 */
export const PERSONA_MEMORY_GATEWAY_SERVER = 'flujo.persona-memory';

/** Deterministic maintenance-only operation; never offered to a model. */
export const PERSONA_MEMORY_MAINTENANCE_COMMIT_TOOL = 'validate_and_commit_candidates';

/** Run-scoped handoff from the maintenance extractor Process to the commit node. */
export const PERSONA_MEMORY_MAINTENANCE_OUTPUT_VARIABLE = 'persona_memory_candidates';
