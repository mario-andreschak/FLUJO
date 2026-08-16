import { alpha, type Theme } from '@mui/material/styles';

import { flowNodeColors } from '@/frontend/utils/flowPaletteTokens';
import type { ConversationOriginKey } from './conversationOrigin';

export type ConversationCardStatus =
  | 'running'
  | 'awaiting_tool_approval'
  | 'paused_debug'
  | 'completed'
  | 'error'
  | 'capped';

/** Match conversation origins to the same semantic colors used by FlowBuilder. */
export function conversationOriginColor(key: ConversationOriginKey, theme: Theme): string {
  switch (key) {
    // "Ask another agent" / Subflow node.
    case 'subflow': return theme.palette.warning.main;
    // "Notify an automation" / Signal node.
    case 'schedule':
    case 'trigger': return flowNodeColors.light.signal;
    // Connected-app runs retain the FlowBuilder MCP cyan.
    case 'mcp': return theme.palette.info.main;
    case 'meeting': return theme.palette.secondary.main;
    // Direct conversations and unclassified runs use the Process node color.
    case 'chat':
    case 'unknown':
    case 'api':
    case 'internal':
    default: return theme.palette.primary.main;
  }
}

/** Resolve the old status-dot color to a concrete value for the card's 25% segment. */
export function conversationStatusColor(
  status: ConversationCardStatus | null | undefined,
  theme: Theme,
): string {
  switch (status) {
    case 'running': return theme.palette.primary.main;
    case 'awaiting_tool_approval': return theme.palette.warning.main;
    case 'paused_debug': return theme.palette.secondary.main;
    case 'completed': return theme.palette.success.main;
    case 'capped': return theme.palette.info.main;
    case 'error': return theme.palette.error.main;
    default: return theme.palette.text.disabled;
  }
}

/** A restrained 90/10 surface split: invocation origin first, current status second. */
export function conversationCardSplitBackground(
  originColor: string,
  statusColor: string,
  strength: number,
): string {
  const origin = alpha(originColor, strength);
  const status = alpha(statusColor, strength);
  return `linear-gradient(90deg, ${origin} 0%, ${origin} 90%, ${status} 90%, ${status} 100%)`;
}
