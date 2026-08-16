"use client";

import { memo } from 'react';
import { Box, Typography } from '@mui/material';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownLink } from '@/frontend/components/shared/MarkdownLink';

// Shared by ChatMessages and meeting logs so both surfaces render the same
// headings, links, lists, quotes, and code without duplicating chat markup.
const CHAT_MARKDOWN_COMPONENTS: Components = {
  p: (props) => <Typography variant="body1" sx={{ mb: 0.5, whiteSpace: 'pre-line' }}>{props.children}</Typography>,
  h1: (props) => <Typography variant="h5" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
  h2: (props) => <Typography variant="h6" sx={{ mt: 2, mb: 0.5 }}>{props.children}</Typography>,
  h3: (props) => <Typography variant="subtitle1" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
  h4: (props) => <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>{props.children}</Typography>,
  h5: (props) => <Typography variant="body1" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
  h6: (props) => <Typography variant="body2" sx={{ mt: 1, mb: 0.5, fontWeight: 'bold' }}>{props.children}</Typography>,
  ul: (props) => <Box component="ul" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
  ol: (props) => <Box component="ol" sx={{ pl: 2, mb: 1 }}>{props.children}</Box>,
  li: (props) => <Box component="li" sx={{ mb: 0.5, whiteSpace: 'pre-line' }}>{props.children}</Box>,
  a: MarkdownLink,
  blockquote: (props) => <Box component="blockquote" sx={{ borderLeft: '4px solid', borderColor: 'divider', pl: 2, py: 0.5, my: 1, bgcolor: 'action.hover', borderRadius: '4px' }}>{props.children}</Box>,
  code: ({ className, children }: any) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    return isInline
      ? <Typography component="code" sx={{ bgcolor: 'action.hover', px: 0.5, py: 0.25, borderRadius: '4px', fontFamily: 'monospace', wordBreak: 'break-all' }}>{children}</Typography>
      : <Box component="pre" sx={{ bgcolor: 'action.hover', p: 1.5, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace', fontSize: '0.875rem', my: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{children}</Box>;
  },
};

export const ChatMarkdownContent = memo(function ChatMarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>{children}</ReactMarkdown>;
});

