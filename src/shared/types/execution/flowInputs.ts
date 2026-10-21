import type { McpAppModelContextMap } from '../chat';

/** Data-only inputs retained for deterministic flow replay. */
export interface FlowReplayInputs {
  /** Named inputs seeded onto the flow's variables at run start. */
  variables?: Record<string, unknown>;
  /** Latest future-turn context supplied by mounted MCP Apps. */
  mcpAppContexts?: McpAppModelContextMap;
}
