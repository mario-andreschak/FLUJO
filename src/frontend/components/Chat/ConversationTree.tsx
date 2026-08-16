'use client';

import React from 'react';
import { Box, Collapse, IconButton, Tooltip, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { ConversationListItem } from './index';
import { useI18n } from '@/frontend/contexts/I18nContext';

/** Hard cap on nesting depth so a pathological/self-referential chain can't
 *  blow the render stack. Mirrors the Waves `SubflowTree` depth discipline. */
export const MAX_CONVERSATION_TREE_DEPTH = 20;

export interface ConversationTreeProps {
  /** Conversations to render at this level (already sorted by the caller). */
  nodes: ConversationListItem[];
  /** parentConversationId -> child conversations, built once by the caller. */
  childrenByParent: Map<string, ConversationListItem[]>;
  /** Render one conversation row. `depth` lets the caller indent/annotate. */
  renderItem: (conversation: ConversationListItem, depth: number) => React.ReactNode;
  /** Per-node expand state (id -> expanded). A node is expanded unless it is
   *  explicitly `false`, so chains are visible by default. */
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  depth?: number;
  /** Ids already rendered on the path to here — the cycle guard. */
  visited?: Set<string>;
  maxDepth?: number;
  /** Direct parent rendered immediately above this recursive level. */
  parent?: ConversationListItem;
}

/**
 * Renders conversations as a recursive tree (issue #182), nesting child
 * conversations under the parent that spawned them. Mirrors the Waves
 * `SubflowTree` conventions: depth-based left padding + a dashed border, a hard
 * depth cap, and a visited-set cycle guard so a corrupt parent link can never
 * recurse forever.
 */
export default function ConversationTree({
  nodes,
  childrenByParent,
  renderItem,
  expanded,
  onToggle,
  depth = 0,
  visited,
  maxDepth = MAX_CONVERSATION_TREE_DEPTH,
  parent,
}: ConversationTreeProps): React.ReactElement | null {
  const { t } = useI18n();
  const theme = useTheme();
  if (!nodes || nodes.length === 0) return null;
  if (depth > maxDepth) return null;
  const seen = visited ?? new Set<string>();

  return (
    <>
      {nodes.map((node, index) => {
        // Cycle guard: an id already on this path means the parent chain loops.
        if (seen.has(node.id)) return null;
        const children = childrenByParent.get(node.id) ?? [];
        const hasChildren = children.length > 0 && depth < maxDepth;
        const isExpanded = expanded[node.id] !== false;
        const nextVisited = new Set(seen);
        nextVisited.add(node.id);
        const isLastSibling = index === nodes.length - 1;
        const connectorColor = alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.5 : 0.34);
        return (
          <Box
            key={node.id}
            data-tree-depth={depth}
            sx={{
              position: 'relative',
              pl: depth > 0 ? 3.25 : 0,
              ...(depth > 0 ? {
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  left: 12,
                  top: 0,
                  bottom: isLastSibling ? 'calc(100% - 31px)' : 0,
                  borderLeft: `2px solid ${connectorColor}`,
                },
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  left: 12,
                  top: 30,
                  width: 14,
                  borderTop: `2px solid ${connectorColor}`,
                  borderTopLeftRadius: 6,
                },
              } : {}),
            }}
          >
            {depth > 0 && parent && (
              <Tooltip title={t('chat.chain.childOf', { title: parent.title })}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: 'block', ml: 4.25, mb: 0.15, maxWidth: 'calc(100% - 40px)', fontWeight: 650 }}
                >
                  ↳ {t('chat.chain.childOf', { title: parent.title })}
                </Typography>
              </Tooltip>
            )}
            <Box sx={{ display: 'flex', alignItems: 'flex-start' }}>
              {hasChildren ? (
                <IconButton
                  size="small"
                  onClick={() => onToggle(node.id)}
                  aria-label={isExpanded ? t('chat.chain.collapse') : t('chat.chain.expand')}
                  sx={{
                    mt: 0.5,
                    flexShrink: 0,
                    zIndex: 1,
                    border: '1px solid',
                    borderColor: connectorColor,
                    bgcolor: 'background.paper',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {isExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                </IconButton>
              ) : (
                <Box sx={{ width: 34, flexShrink: 0 }} />
              )}
              <Box sx={{ flex: 1, minWidth: 0 }}>{renderItem(node, depth)}</Box>
            </Box>
            {hasChildren && (
              <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                <ConversationTree
                  nodes={children}
                  childrenByParent={childrenByParent}
                  renderItem={renderItem}
                  expanded={expanded}
                  onToggle={onToggle}
                  depth={depth + 1}
                  visited={nextVisited}
                  maxDepth={maxDepth}
                  parent={node}
                />
              </Collapse>
            )}
          </Box>
        );
      })}
    </>
  );
}
