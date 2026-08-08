/**
 * Read-only "chain chat" projection contract (issue #405).
 *
 * These types describe the ONLY conversation data the experimental chain-chat
 * page receives: chain topology plus one bounded, plain-text preview of the
 * latest displayable message per node. Full histories, tool payloads, model
 * context and provider errors are deliberately absent — the page is view-only
 * and must never become a second, weaker conversation-read path.
 */

/** Mirrors `SharedState['status']` without importing backend code. */
export type ConversationChainNodeStatus =
  | 'running'
  | 'awaiting_tool_approval'
  | 'paused_debug'
  | 'completed'
  | 'error'
  | 'capped';

/** Hard cap on the message preview returned per node. */
export const CHAIN_MESSAGE_PREVIEW_MAX_CHARS = 240;

/** Bounded, plain-text projection of a node's latest displayable message. */
export interface ConversationChainMessagePreview {
  /** Only user- or assistant-visible messages are previewed. */
  role: 'user' | 'assistant';
  /** Whitespace-collapsed plain text, never HTML, never longer than the cap. */
  text: string;
  /** Message timestamp, 0 when the stored message has none. */
  timestamp: number;
  /** True when `text` was cut at the cap. */
  truncated: boolean;
}

export interface ConversationChainNode {
  id: string;
  title: string;
  status?: ConversationChainNodeStatus;
  /** True when the node's status is in the shared active allowlist. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
  parentConversationId: string | null;
  rootConversationId: string | null;
  /** Null when the conversation has no displayable message yet. */
  lastMessage: ConversationChainMessagePreview | null;
  /** True when the preview could not be resolved (oversized/unreadable snapshot). */
  previewUnavailable?: boolean;
}

export interface ConversationChainGraph {
  /** Id of the conversation at the top of this chain. */
  rootId: string;
  title: string;
  /** Most recent `updatedAt` across the chain's returned nodes. */
  updatedAt: number;
  activeNodeCount: number;
  /** Node count BEFORE the per-chain cap was applied. */
  totalNodeCount: number;
  /** True when nodes were dropped by the per-chain cap. */
  truncated: boolean;
  nodes: ConversationChainNode[];
}

export interface ConversationChainsResponse {
  chains: ConversationChainGraph[];
  /** Chain count BEFORE the chain cap was applied. */
  totalChains: number;
  /** True when chains were dropped by the chain cap. */
  truncated: boolean;
  /** The active-status allowlist actually used, so the UI can explain itself. */
  activeStatuses: string[];
  generatedAt: number;
}
