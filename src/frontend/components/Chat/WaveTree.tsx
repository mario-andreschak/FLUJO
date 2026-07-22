'use client';

import React from 'react';
import { Box, Collapse, IconButton, Typography, Chip, Tooltip } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { ConversationListItem } from './index';
import type { WaveChainNode } from '@/shared/types/waves/waves';
import { triggerKindMeta } from '@/frontend/components/Waves/triggerKindMeta';

/** Hard cap on nesting depth so a pathological/cyclic wave can't blow the
 *  render stack. Mirrors `ConversationTree`'s depth discipline. */
export const MAX_WAVE_TREE_DEPTH = 20;

export interface WaveTreeProps {
  /** Execution ids to render at this level (roots at the top level). */
  executionIds: string[];
  /** parent executionId -> ordered child executionIds. */
  childrenByExecution: Map<string, string[]>;
  /** executionId -> chain node (name / triggerKind for the row header). */
  nodeById: Map<string, WaveChainNode>;
  /** executionId -> conversations attached to it (already sorted by caller). */
  conversationsByExecution: Map<string, ConversationListItem[]>;
  /** Executions whose subtree contains at least one conversation. */
  renderable: Set<string>;
  /** Render one conversation row. */
  renderItem: (conversation: ConversationListItem) => React.ReactNode;
  /** Per-execution expand state (execId -> expanded); expanded unless `false`. */
  expanded: Record<string, boolean>;
  onToggle: (executionId: string) => void;
  depth?: number;
  /** Execution ids already on the path to here — the cycle guard. */
  visited?: Set<string>;
  maxDepth?: number;
}

/**
 * Renders a wave as a tree of EXECUTIONS (issue #214), nesting the
 * conversations that ran from each execution under it — giving "Group by wave"
 * the same hierarchy that "Group by chain" has. Internal nodes are executions
 * (ordered by the wave's spanning tree, with a trigger-kind label + a count of
 * the conversations directly attached); leaves are conversations. Empty
 * executions are pruned by the caller via `renderable`.
 *
 * Mirrors `ConversationTree`: depth-based indent + dashed border, a hard depth
 * cap, and a visited-set cycle guard so a corrupt/recursive wave can never
 * recurse forever.
 */
export default function WaveTree({
  executionIds,
  childrenByExecution,
  nodeById,
  conversationsByExecution,
  renderable,
  renderItem,
  expanded,
  onToggle,
  depth = 0,
  visited,
  maxDepth = MAX_WAVE_TREE_DEPTH,
}: WaveTreeProps): React.ReactElement | null {
  if (!executionIds || executionIds.length === 0) return null;
  if (depth > maxDepth) return null;
  const seen = visited ?? new Set<string>();

  return (
    <>
      {executionIds
        .filter((execId) => renderable.has(execId) && !seen.has(execId))
        .map((execId) => {
          const node = nodeById.get(execId);
          const conversations = conversationsByExecution.get(execId) ?? [];
          const childExecutions = (childrenByExecution.get(execId) ?? []).filter((c) =>
            renderable.has(c),
          );
          const hasBody =
            (conversations.length > 0 || childExecutions.length > 0) && depth < maxDepth;
          const isExpanded = expanded[execId] !== false;
          const nextVisited = new Set(seen);
          nextVisited.add(execId);

          const kind = node?.triggerKind ?? 'flow-event';
          const meta = triggerKindMeta(kind);
          const name = node?.name || node?.flowName || execId;

          return (
            <Box
              key={execId}
              sx={{
                pl: depth > 0 ? 1.5 : 0,
                borderLeft: depth > 0 ? '1px dashed rgba(128,128,128,0.35)' : 'none',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                {hasBody ? (
                  <IconButton
                    size="small"
                    onClick={() => onToggle(execId)}
                    aria-label={isExpanded ? 'Collapse execution' : 'Expand execution'}
                    sx={{ flexShrink: 0 }}
                  >
                    {isExpanded ? (
                      <ExpandLessIcon fontSize="small" />
                    ) : (
                      <ExpandMoreIcon fontSize="small" />
                    )}
                  </IconButton>
                ) : (
                  <Box sx={{ width: 34, flexShrink: 0 }} />
                )}
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    py: 0.25,
                  }}
                >
                  <Tooltip title={`${meta.label} trigger`}>
                    <Box
                      component="span"
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: meta.color,
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={name} enterDelay={500}>
                    <Typography
                      variant="body2"
                      sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}
                      noWrap
                    >
                      {name}
                    </Typography>
                  </Tooltip>
                  {conversations.length > 0 && (
                    <Chip
                      label={conversations.length}
                      size="small"
                      sx={{
                        height: 18,
                        flexShrink: 0,
                        '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' },
                      }}
                    />
                  )}
                </Box>
              </Box>
              {hasBody && (
                <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                  <Box
                    sx={{
                      pl: 1.5,
                      borderLeft: '1px dashed rgba(128,128,128,0.35)',
                    }}
                  >
                    {conversations.map((conversation) => (
                      <Box key={conversation.id}>{renderItem(conversation)}</Box>
                    ))}
                  </Box>
                  <WaveTree
                    executionIds={childExecutions}
                    childrenByExecution={childrenByExecution}
                    nodeById={nodeById}
                    conversationsByExecution={conversationsByExecution}
                    renderable={renderable}
                    renderItem={renderItem}
                    expanded={expanded}
                    onToggle={onToggle}
                    depth={depth + 1}
                    visited={nextVisited}
                    maxDepth={maxDepth}
                  />
                </Collapse>
              )}
            </Box>
          );
        })}
    </>
  );
}
