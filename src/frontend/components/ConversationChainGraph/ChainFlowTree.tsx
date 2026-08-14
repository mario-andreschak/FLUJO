'use client';

import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import CallSplitRoundedIcon from '@mui/icons-material/CallSplitRounded';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { ConversationChainNode } from '@/shared/types/conversationChain';
import {
  buildConversationChainTree,
  chainBranchIsActive,
  type ConversationChainTreeNode,
} from '@/utils/shared/conversationChainTree';
import ChainConversationCard from './ChainConversationCard';
import ChainTranscriptPopover from './ChainTranscriptPopover';

export interface ChainFlowTreeProps {
  rootId: string;
  nodes: ConversationChainNode[];
  onOpenConversation: (conversationId: string) => void;
  reducedMotion?: boolean;
  compact?: boolean;
}

interface BranchProps {
  node: ConversationChainTreeNode;
  rootId: string;
  compact: boolean;
  reducedMotion: boolean;
  entranceIndex: number;
  previewId: string | null;
  onOpenConversation: (conversationId: string) => void;
  onOpenPreview: (anchor: HTMLElement, conversation: ConversationChainNode) => void;
}

function Branch({
  node,
  rootId,
  compact,
  reducedMotion,
  entranceIndex,
  previewId,
  onOpenConversation,
  onOpenPreview,
}: BranchProps) {
  const activeBranch = chainBranchIsActive(node);
  const hasChildren = node.children.length > 0;

  return (
    <Box
      component="li"
      data-chain-id={node.id}
      data-branch-active={activeBranch ? 'true' : 'false'}
    >
      <ChainConversationCard
        conversation={node.conversation}
        isRoot={node.id === rootId && node.depth === 0}
        detached={node.detached}
        compact={compact}
        reducedMotion={reducedMotion}
        entranceIndex={entranceIndex}
        previewOpen={previewId === node.id}
        onOpenConversation={onOpenConversation}
        onOpenPreview={onOpenPreview}
      />
      {hasChildren && (
        <Box component="ul">
          {node.children.map((child) => (
            <Branch
              key={child.id}
              node={child}
              rootId={rootId}
              compact={compact}
              reducedMotion={reducedMotion}
              entranceIndex={entranceIndex + child.depth + 1}
              previewId={previewId}
              onOpenConversation={onOpenConversation}
              onOpenPreview={onOpenPreview}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function ChainFlowTree({
  rootId,
  nodes,
  onOpenConversation,
  reducedMotion = false,
  compact = false,
}: ChainFlowTreeProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const model = useMemo(() => buildConversationChainTree(nodes), [nodes]);
  const indexById = useMemo(() => new Map(nodes.map((node, index) => [node.id, index])), [nodes]);
  const structureKey = useMemo(
    () => nodes.map((node) => `${node.id}:${node.parentConversationId ?? ''}`).join('|'),
    [nodes],
  );
  const treeViewportRef = useRef<HTMLDivElement | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null);
  const previewNode = useMemo(
    () => nodes.find((node) => node.id === previewId) ?? null,
    [nodes, previewId],
  );

  const connector = alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.18 : 0.14);
  const activeConnector = alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.58 : 0.4);
  const branchGap = compact ? 42 : 52;

  const openPreview = (anchor: HTMLElement, conversation: ConversationChainNode) => {
    if (previewId === conversation.id && previewAnchor) {
      setPreviewAnchor(null);
      setPreviewId(null);
      return;
    }
    setPreviewId(conversation.id);
    setPreviewAnchor(anchor);
  };

  const closePreview = () => {
    setPreviewAnchor(null);
    setPreviewId(null);
  };

  // Wide sibling groups remain readable at 1:1 scale. Start the ordinary
  // scroll container at its visual centre so the root is actually what the
  // user sees first (no graph camera or fit-to-canvas zoom required).
  useLayoutEffect(() => {
    const viewport = treeViewportRef.current;
    if (!viewport) return;
    const rootItem = [...viewport.querySelectorAll<HTMLElement>('[data-chain-id]')]
      .find((element) => element.dataset.chainId === rootId);
    const identity = rootItem?.querySelector<HTMLElement>('.chain-identity');
    if (!identity) {
      viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    viewport.scrollLeft +=
      identityRect.left + identityRect.width / 2 - (viewportRect.left + viewportRect.width / 2);
  }, [compact, rootId, structureKey]);

  return (
    <Box
      ref={treeViewportRef}
      data-testid="chain-flow-tree"
      data-layout="top-down"
      role="region"
      aria-label={t('chainChat.treeLabel')}
      sx={{
        position: 'relative',
        minHeight: 430,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'visible',
        scrollbarWidth: 'thin',
        scrollbarColor: `${alpha(theme.palette.text.primary, 0.18)} transparent`,
        bgcolor: 'transparent',
        backgroundImage: `radial-gradient(circle at 50% 0%, ${alpha(theme.palette.primary.main, 0.065)}, transparent 29%)`,
        '& .chain-tree-roots, & ul': {
          display: 'flex',
          width: 'max-content',
          minWidth: '100%',
          m: 0,
          p: 0,
          listStyle: 'none',
          justifyContent: 'center',
          alignItems: 'flex-start',
        },
        '& li': {
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          m: 0,
          listStyle: 'none',
        },
        '& .chain-tree-roots': {
          boxSizing: 'border-box',
          gap: compact ? 5 : 8,
          px: compact ? 2 : 4,
          pt: compact ? 2.5 : 3.5,
          pb: 7,
        },
        '& li > ul': {
          position: 'relative',
          pt: `${branchGap}px`,
        },
        '& li > ul::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          left: '50%',
          width: 1.5,
          height: `${branchGap}px`,
          borderRadius: 99,
          background: connector,
          transform: 'translateX(-50%)',
        },
        '& li > ul > li': {
          px: compact ? 1 : 1.35,
          pt: `${branchGap}px`,
        },
        '& li > ul > li::before, & li > ul > li::after': {
          content: '""',
          position: 'absolute',
          top: 0,
          right: '50%',
          width: '50%',
          height: `${branchGap}px`,
          borderTop: `1.5px solid ${connector}`,
        },
        '& li > ul > li::after': {
          right: 'auto',
          left: '50%',
          borderLeft: `1.5px solid ${connector}`,
        },
        '& li > ul > li:only-child::before, & li > ul > li:only-child::after': {
          display: 'none',
        },
        '& li > ul > li:only-child': {
          pt: 0,
        },
        '& li > ul > li:first-of-type::before, & li > ul > li:last-of-type::after': {
          borderTopColor: 'transparent',
        },
        '& li > ul > li:last-of-type::before': {
          borderRight: `1.5px solid ${connector}`,
          borderTopRightRadius: 12,
        },
        '& li > ul > li:first-of-type::after': {
          borderTopLeftRadius: 12,
        },
        '& li[data-branch-active="true"] > ul::before': {
          background: `linear-gradient(180deg, ${activeConnector}, ${connector})`,
        },
        '& li > ul > li[data-branch-active="true"]::before, & li > ul > li[data-branch-active="true"]::after': {
          borderTopColor: activeConnector,
        },
        '& li > ul > li[data-branch-active="true"]::after': {
          borderLeftColor: activeConnector,
        },
        '& li > ul > li[data-branch-active="true"]:first-of-type::before, & li > ul > li[data-branch-active="true"]:last-of-type::after': {
          borderTopColor: 'transparent',
        },
        '& li[data-branch-active="true"] > ul::after': reducedMotion
          ? undefined
          : {
              content: '""',
              position: 'absolute',
              top: 4,
              left: '50%',
              width: 5,
              height: 5,
              zIndex: 1,
              borderRadius: '50%',
              bgcolor: 'primary.light',
              boxShadow: `0 0 10px ${alpha(theme.palette.primary.main, 0.7)}`,
              transform: 'translateX(-50%)',
              animation: `chainSignalTravel ${conversationSignalDuration(nodes.length)}ms ease-in-out infinite`,
            },
        '@keyframes chainSignalTravel': {
          '0%': { top: 3, opacity: 0, transform: 'translateX(-50%) scale(.7)' },
          '18%': { opacity: 0.9 },
          '78%': { opacity: 0.72 },
          '100%': { top: `${Math.max(8, branchGap - 6)}px`, opacity: 0, transform: 'translateX(-50%) scale(1)' },
        },
      }}
    >
      <Box
        component="ul"
        className="chain-tree-roots"
      >
        {model.roots.map((root) => (
          <Branch
            key={root.id}
            node={root}
            rootId={rootId}
            compact={compact}
            reducedMotion={reducedMotion}
            entranceIndex={indexById.get(root.id) ?? 0}
            previewId={previewId}
            onOpenConversation={onOpenConversation}
            onOpenPreview={openPreview}
          />
        ))}
      </Box>

      {model.detachedIds.length > 0 && (
        <Stack direction="row" justifyContent="center" sx={{ position: 'sticky', left: 0, px: 2, pb: 2 }}>
          <Chip
            size="small"
            variant="outlined"
            icon={<CallSplitRoundedIcon />}
            label={t('chainChat.detachedNotice')}
            sx={{ maxWidth: 520, color: 'text.secondary', bgcolor: alpha(theme.palette.background.paper, 0.76) }}
          />
        </Stack>
      )}

      <ChainTranscriptPopover
        node={previewNode}
        anchorEl={previewAnchor}
        onClose={closePreview}
        onOpenConversation={onOpenConversation}
        reducedMotion={reducedMotion}
        compact={compact}
      />
    </Box>
  );
}

function conversationSignalDuration(nodeCount: number): number {
  return 2300 + Math.min(Math.max(nodeCount, 1), 20) * 35;
}
