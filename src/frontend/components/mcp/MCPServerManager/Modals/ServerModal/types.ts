import { MCPServerConfig } from '@/utils/mcp';

export type ServerSetupTab = 'spotlight' | 'marketplace' | 'github' | 'configure' | 'reference' | 'remote';

/**
 * The one message an acquisition tab (Spotlight / Marketplace / GitHub /
 * Reference / Remote) can send (#392). Before this existed, every new
 * source→sink message was paid for with another prop on `TabProps`, which all
 * six tabs implement. `ServerModal` owns the handoff, derives the inbound
 * props from it, and performs the tab switch itself.
 */
export type TabHandoff =
  | { to: 'configure'; config: MCPServerConfig; autoTestRun?: boolean }
  | { to: 'github'; repoUrl: string };

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
  /** Add-mode tab selected by the guided connection wizard. */
  initialTab?: ServerSetupTab;
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
  /**
   * Hand this tab's result to another tab. The modal switches tabs; a tab never
   * does that itself. Replaces the former `setActiveTab` + `onOpenInGitHubTab`
   * prop pair (#392).
   */
  onHandoff?: (handoff: TabHandoff) => void;
  /** When true (registry handoff), collapse define/build as done and auto-start a test run */
  autoTestRun?: boolean;
  /**
   * Identity of the inbound handoff. Bumped on every handoff so the configure
   * tab can re-arm its auto-run guard — installing the same server twice in a
   * row must start a test run both times (#392).
   */
  handoffId?: number;
  /** GitHub tab: prefill for the repository URL field (marketplace → manual install handoff) */
  initialGitHubUrl?: string;
}
