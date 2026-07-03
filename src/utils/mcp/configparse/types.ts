'use client';

import { MessageState } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/types';
import { MCPServerConfig } from '@/shared/types/mcp/mcp';

/**
 * Result of parsing configuration from a repository
 */
export interface ConfigParseResult {
  detected: boolean;
  language?: 'typescript' | 'python' | 'java' | 'kotlin' | 'unknown';
  installCommand?: string;
  buildCommand?: string;
  runCommand?: string;
  args?: string[];
  env?: Record<string, string>;
  message?: MessageState;
  config?: Partial<MCPServerConfig>;
  /** True when the config came from an explicit config block in the README */
  foundExplicitConfig?: boolean;
}

/**
 * Options for parsing configuration
 */
export interface ConfigParseOptions {
  repoPath: string;
  repoName: string;
  owner?: string;
}

/**
 * File existence check result
 */
export interface FileExistsResult {
  exists: boolean;
  content?: string;
}
