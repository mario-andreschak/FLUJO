'use client';

import { MCPServerConfig } from "@/shared/types/mcp";

export type { MCPServerConfig };

export interface ParsedServerConfig {
  config: Partial<MCPServerConfig>;
  message: { type: 'success' | 'error' | 'warning'; text: string } | null;
}
