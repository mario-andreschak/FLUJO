import { MCPServerConfig } from '@/utils/mcp';

/** Outcome of persisting a server and kicking off its OAuth flow from the modal. */
export type SaveAndAuthenticateResult =
  | { status: 'authorized' }
  | { status: 'needs_client_credentials'; error?: string }
  | { status: 'error'; error?: string };

export interface ServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (config: MCPServerConfig) => void;
  initialConfig?: MCPServerConfig | null;
  onUpdate?: (config: MCPServerConfig) => void;
  onRestartAfterUpdate?: (serverName: string) => void;
  /** Persist the (streamable) server and start its OAuth flow without closing the modal
   * until it completes. Bound to the manager, which owns the store + modal state. */
  onSaveAndAuthenticate?: (config: MCPServerConfig) => Promise<SaveAndAuthenticateResult>;
}

export interface MessageState {
  type: 'success' | 'error' | 'warning';
  text: string;
}

export interface RepoInfo {
  owner: string;
  repo: string;
  valid: boolean;
  contents?: any;
}

export interface TabProps {
  initialConfig?: MCPServerConfig | null;
  onAdd: (config: MCPServerConfig) => void;
  // options.autoTestRun marks a handoff whose config is ready to run as-is
  // (marketplace one-click install): the local tab then skips straight to a test run
  onUpdate?: (config: MCPServerConfig, options?: { autoTestRun?: boolean }) => void;
  onClose: () => void;
  onRestartAfterUpdate?: (serverName: string) => void;
  /** Persist the (streamable) server and start its OAuth flow. See ServerModalProps. */
  onSaveAndAuthenticate?: (config: MCPServerConfig) => Promise<SaveAndAuthenticateResult>;
  setActiveTab?: (tab: 'spotlight' | 'marketplace' | 'github' | 'local' | 'reference' | 'remote') => void;
  /** When true (marketplace handoff), collapse define/build as done and auto-start a test run */
  autoTestRun?: boolean;
  /** GitHub tab: prefill for the repository URL field (marketplace → manual install handoff) */
  initialGitHubUrl?: string;
  /** Marketplace tab: open the GitHub tab prefilled with this repository URL */
  onOpenInGitHubTab?: (repoUrl: string) => void;
}
