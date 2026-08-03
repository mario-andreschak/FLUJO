import type { MCPServerConfig } from '@/shared/types/mcp';
import type { ResolvedInstallPlan } from '@/utils/mcp/registry';

export type McpAssistantAuthMode = 'oauth-dcr' | 'oauth-manual' | 'none' | 'unknown';

export interface McpAssistantSource {
  id: 'registry' | 'github' | 'npm' | 'awesome-mcp';
  label: string;
  url: string;
  status: 'searched' | 'unavailable';
  detail?: string;
}

export interface McpAssistantCandidate {
  id: string;
  registryName: string;
  title: string;
  description: string;
  score: number;
  recommended: boolean;
  plan: ResolvedInstallPlan;
  config: Partial<MCPServerConfig>;
  authMode: McpAssistantAuthMode;
  authHelp?: string;
  freeNote: string;
  reasons: string[];
  warnings: string[];
  requiredInputs: string[];
  githubStars?: number;
  weeklyDownloads?: number;
  verificationStatus: string;
  repositoryUrl?: string;
  alternateTransports: Array<'stdio' | 'streamable' | 'sse'>;
}

export interface McpAssistantResearchResult {
  query: string;
  summary: string;
  candidates: McpAssistantCandidate[];
  recommendedId?: string;
  sources: McpAssistantSource[];
  generatedAt: string;
}

export type McpAssistantResearchEvent =
  | { type: 'progress'; stage: 'planning' | 'web' | 'registry' | 'auth' | 'ranking'; message: string }
  | { type: 'complete'; result: McpAssistantResearchResult }
  | { type: 'error'; error: string };

export interface McpAssistantInstallInput {
  registryName: string;
  transport: 'stdio' | 'streamable' | 'sse';
  /** Exact proposal displayed by the UI; install aborts if the Registry changed. */
  reviewedPlan: ResolvedInstallPlan;
  /** The UI must set this only after the exact plan has been shown to the user. */
  approved: true;
  inputs?: Record<string, string>;
  authMode?: McpAssistantAuthMode;
}

export interface McpAssistantInstallResult {
  installed: boolean;
  serverName?: string;
  alreadyExisted?: boolean;
  tools?: Array<{ name: string; description?: string }>;
  needsInputs?: string[];
  needsAuthentication?: boolean;
  plan?: ResolvedInstallPlan;
  error?: string;
}

export interface McpTroubleshootContext {
  modelId: string;
  config: {
    name?: string;
    transport?: string;
    command?: string;
    args?: string[];
    serverUrl?: string;
    rootPath?: string;
    envNames?: string[];
    headerNames?: string[];
    installCommand?: string;
    buildCommand?: string;
  };
  error?: string;
  consoleOutput?: string;
}

export interface McpTroubleshootPatch {
  command?: string;
  args?: string[];
  serverUrl?: string;
  rootPath?: string;
  installCommand?: string;
  buildCommand?: string;
  /** New names only. The assistant never supplies secret values. */
  addEnvNames?: string[];
  /** New names only. The assistant never supplies token/header values. */
  addHeaderNames?: string[];
}

export interface McpTroubleshootResult {
  diagnosis: string;
  steps: string[];
  authHelp?: string;
  patch?: McpTroubleshootPatch;
  researchedUrls?: string[];
}
