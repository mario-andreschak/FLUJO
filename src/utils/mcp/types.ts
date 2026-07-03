'use client';

import { MCPServerConfig } from "@/shared/types/mcp";

export type { MCPServerConfig };

export interface ParsedServerConfig {
  config: Partial<MCPServerConfig>;
  message: { type: 'success' | 'error' | 'warning'; text: string } | null;
  /**
   * True when the text contained an explicit, complete server config block
   * (an "mcpServers" JSON object or a direct command/args object) — as opposed
   * to loose commands scraped from prose/code blocks.
   */
  foundExplicitConfig?: boolean;
}
