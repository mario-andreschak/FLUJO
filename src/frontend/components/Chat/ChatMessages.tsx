"use client";

import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Button,
  FormControl,
  InputLabel,
  Select,
  Switch,
  FormControlLabel
} from '@mui/material';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import BlockIcon from '@mui/icons-material/Block';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HandymanIcon from '@mui/icons-material/Handyman';
import TerminalIcon from '@mui/icons-material/Terminal';
import EditIcon from '@mui/icons-material/Edit';
import ThumbUpIcon from '@mui/icons-material/ThumbUp'; // For Approve
import ThumbDownIcon from '@mui/icons-material/ThumbDown'; // For Reject
import { ChatMessage } from './index';
import OpenAI from 'openai'; // Import OpenAI types for tool calls
import { displayToolName } from '@/utils/shared/common'; // Friendly tool-name decode
import { createLogger } from '@/utils/logger'; // Import the logger

const log = createLogger('frontend/components/Chat/ChatMessages'); // Initialize logger

// How many messages render initially / how many more each expander click adds.
// Long conversations previously rendered EVERY bubble on every update; the
// window keeps steady-state work proportional to what is actually on screen.
const MESSAGES_WINDOW_INITIAL = 50;
const MESSAGES_WINDOW_STEP = 200;

interface ChatMessagesProps {
  messages: ChatMessage[];
  pendingToolCalls?: OpenAI.ChatCompletionMessageToolCall[] | null; // Add pending calls prop
  availableNodes?: { id: string; label: string }[]; // Add available nodes for dropdown
  /** Resets the render window when the user switches conversations. */
  conversationId?: string;
  onToggleDisabled: (messageId: string) => void;
  onSplitConversation: (messageId: string) => void;
  onEditMessage?: (messageId: string, content: string, processNodeId?: string | null) => void;
  onApproveToolCall?: (toolCallId: string) => void; // Add approve handler prop
  onRejectToolCall?: (toolCallId: string) => void; // Add reject handler prop
}

// Type guard to check if a message has tool_calls
function hasToolCalls(message: ChatMessage): message is ChatMessage & { tool_calls: OpenAI.ChatCompletionMessageToolCall[] } {
  return message.role === 'assistant' && 'tool_calls' in message && Array.isArray(message.tool_calls);
}

// Compact token count for the per-message chip (12345 → "12.3k").
const formatTokenCount = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `${n}`;

// Format timestamp
const formatTime = (timestamp: number) => {
  // Add a check for valid timestamp before formatting
  if (typeof timestamp !== 'number' || isNaN(timestamp)) {
    log.warn('formatTime received invalid timestamp:', timestamp);
    return 'Invalid Date';
  }
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Markdown renderers are pure of any per-message state, so they live at module
// scope: a stable identity means memoized bubbles don't re-parse/re-render
// their markdown when the list re-renders.
const MARKDOWN_COMPONENTS: Components = {
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
  a: (props) => <Typography component="a" sx={{ color: 'primary.main' }} href={props.href}>{props.children}</Typography>,
  blockquote: (props) => (
    <Box component="blockquote" sx={{
      borderLeft: '4px solid',
      borderColor: 'divider',
      pl: 2,
      py: 0.5,
      my: 1,
      bgcolor: 'action.hover',
      borderRadius: '4px'
    }}>{props.children}</Box>
  ),
  code: ({ node, className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    return isInline ? (
      <Typography component="code" sx={{
        bgcolor: 'action.hover', px: 0.5, py: 0.25, borderRadius: '4px', fontFamily: 'monospace',
        wordBreak: 'break-all', // Break inline code if needed
      }}>{children}</Typography>
    ) : (
      <Box component="pre" sx={{
        bgcolor: 'action.hover', p: 1.5, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
        fontSize: '0.875rem', my: 1, whiteSpace: 'pre-wrap', // Ensure wrapping in code blocks
        wordBreak: 'break-word', // Break long words in code blocks
      }}>{children}</Box>
    );
  }
};

/** Edit state, present only on the single bubble currently being edited. */
interface BubbleEditState {
  content: string;
  nodeId: string | null;
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** Resolved node label for the attribution pill (id shown in the tooltip). */
  nodeLabel?: string;
  /** Stable reference (memoized by the parent) — used by the edit-mode Select. */
  availableNodes: { id: string; label: string }[];
  /** Raw/rendered toggle for tool results (scoped to this bubble). */
  showRaw: boolean;
  /** Non-null only while THIS bubble is in edit mode. */
  edit: BubbleEditState | null;
  onMenuOpen: (event: React.MouseEvent<HTMLElement>, messageId: string) => void;
  onToggleRaw: (messageId: string, checked: boolean) => void;
  onEditContentChange: (content: string) => void;
  onEditNodeChange: (nodeId: string) => void;
  /** Passed only to the bubble being edited (undefined elsewhere, keeps memo stable). */
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

/**
 * One message bubble, memoized. This is the chat's hot render path: markdown
 * parsing (ReactMarkdown) happens in here, so the memo boundary is what stops
 * every SSE event / indicator tick from re-parsing the entire conversation.
 * All props are primitives, stable callbacks, or per-bubble values that only
 * change when THIS message changes.
 */
const MessageBubble = React.memo<MessageBubbleProps>(function MessageBubble({
  message,
  nodeLabel,
  availableNodes,
  showRaw,
  edit,
  onMenuOpen,
  onToggleRaw,
  onEditContentChange,
  onEditNodeChange,
  onSaveEdit,
  onCancelEdit,
}) {
  // Subflow steps (depth > 0) render nested: indented per level, marked with a
  // guide line + chip. They are display-only (never sent back as history).
  const depth = message.depth ?? 0;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
        opacity: message.disabled ? 0.5 : 1,
        ...(depth > 0 && {
          pl: 3 * depth,
          borderLeft: '2px solid',
          borderColor: 'divider',
          ml: 1,
        }),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
          {message.role === 'user'
            ? 'You'
            : message.role === 'assistant'
              ? 'Assistant'
              : message.role === 'tool'
                ? 'Tool'
                : 'System'} • {formatTime(message.timestamp)}
        </Typography>

        {message.processNodeId && (
          <Tooltip title={`${nodeLabel ? `${nodeLabel} — ` : ''}Process Node ID: ${message.processNodeId}`}>
            <Chip
              label={`Node: ${nodeLabel || `${message.processNodeId.substring(0, 6)}...`}`}
              size="small"
              color="primary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {depth > 0 && (
          <Tooltip title={`Nested subflow step (depth ${depth})`}>
            <Chip
              label="Subflow step"
              size="small"
              color="secondary"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        {message.disabled && (
          <Chip
            label="Disabled"
            size="small"
            color="default"
            variant="outlined"
            sx={{ height: 20, fontSize: '0.7rem' }}
          />
        )}

        {message.usage && (
          <Tooltip title={`${message.usage.promptTokens.toLocaleString()} prompt + ${message.usage.completionTokens.toLocaleString()} completion tokens (provider-reported)`}>
            <Chip
              label={`${formatTokenCount(message.usage.totalTokens)} tok`}
              size="small"
              color="default"
              variant="outlined"
              sx={{ height: 20, fontSize: '0.7rem', mr: 1 }}
            />
          </Tooltip>
        )}

        <IconButton
          size="small"
          onClick={(e) => onMenuOpen(e, message.id)}
          sx={{ ml: 1 }}
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Box>

      <Paper
        elevation={1}
        sx={{
          p: 2,
          maxWidth: '75vw', // Set max width to 75% of viewport width
          borderRadius: 2,
          bgcolor: message.role === 'user'
            ? 'primary.light'
            : message.role === 'assistant' || message.role === 'tool'
              ? 'background.paper'
              : 'info.light',
          color: message.role === 'user'
            ? 'primary.contrastText'
            : message.role === 'assistant' || message.role === 'tool'
              ? 'text.primary'
              : 'info.contrastText',
          position: 'relative',
          borderLeft: message.role === 'tool' ? '4px solid' : 'none',
          borderColor: message.role === 'tool' ? 'grey.400' : 'transparent',
          overflowWrap: 'break-word', // Ensure long words break
          wordBreak: 'break-word', // Ensure words break correctly
          // NOTE: do NOT set white-space: pre-wrap here. react-markdown emits
          // literal "\n" text nodes *between* block elements; a pre-wrap
          // container renders those as visible blank lines on top of the
          // paragraph block margins, which doubled the spacing for every
          // newline. Whitespace is instead preserved per-block (see the `p`
          // and `li` renderers above, which use `pre-line`).
          overflow: 'hidden', // Prevent content from visually overflowing the paper
        }}
      >
        {edit ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <textarea
              value={edit.content}
              onChange={(e) => onEditContentChange(e.target.value)}
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                backgroundColor: 'white',
                color: 'black',
              }}
            />
            <FormControl fullWidth size="small" sx={{ mt: 1 }}>
              <InputLabel id="node-id-select-label">Process Node</InputLabel>
              <Select
                labelId="node-id-select-label"
                id="node-id-select"
                value={edit.nodeId || (availableNodes.length > 0 ? availableNodes[0].id : "")}
                label="Process Node"
                onChange={(e) => onEditNodeChange(e.target.value)}
              >
                {availableNodes.map((node) => (
                  <MenuItem key={node.id} value={node.id}>
                    {node.label || node.id.substring(0, 8)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
              <Button
                variant="outlined"
                size="small"
                onClick={onCancelEdit}
              >
                Cancel
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={onSaveEdit}
              >
                Save
              </Button>
            </Box>
          </Box>
        ) : (
          <>
            {/* Render message content only if it's a string and not a tool message */}
            {message.role !== 'tool' && typeof message.content === 'string' && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={MARKDOWN_COMPONENTS}
              >
                {message.content}
              </ReactMarkdown>
            )}
            {/* Multipart content (text + images): a user turn that carried a
                pasted/attached image is stored as an OpenAI content-part
                array. Render text parts as markdown and image_url parts as
                inline images. */}
            {message.role !== 'tool' && Array.isArray(message.content) && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {(message.content as any[]).map((part, partIndex) => {
                  if (part?.type === 'text') {
                    return (
                      <ReactMarkdown key={partIndex} remarkPlugins={[remarkGfm]}>
                        {part.text}
                      </ReactMarkdown>
                    );
                  }
                  if (part?.type === 'image_url' && part.image_url?.url) {
                    return (
                      <img
                        key={partIndex}
                        src={part.image_url.url}
                        alt={`Image ${partIndex + 1}`}
                        style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                      />
                    );
                  }
                  return null;
                })}
              </Box>
            )}
            {/* Fallback for non-string, non-array content (e.g., assistant message with only tool calls) */}
            {message.role !== 'tool' && typeof message.content !== 'string' && !Array.isArray(message.content) && !hasToolCalls(message) && (
               <Typography variant="body2" fontStyle="italic" color="text.secondary">
                 [No text content]
               </Typography>
            )}
          </>
        )}

        {/* Display tool calls if any - use type guard */}
        {hasToolCalls(message) && message.tool_calls.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'primary.main', mb: 1 }}>
              <HandymanIcon fontSize="small" sx={{ mr: 1 }} />
              The assistant is using a tool
            </Typography>

            {message.tool_calls.map((toolCall, tcIndex) => { // Added index for key
              const toolName = displayToolName(toolCall.function.name);
              let formattedArgs = toolCall.function.arguments;
              try {
                const parsedArgs = JSON.parse(toolCall.function.arguments);
                formattedArgs = JSON.stringify(parsedArgs, null, 2);
              } catch (e) { /* Use original string */ }

              return (
                <Accordion
                  key={toolCall.id || `tc-${message.id}-${tcIndex}`} // Use toolCall.id as key
                  defaultExpanded={false}
                  sx={{ mb: 0.5, '&:before': { display: 'none' }, boxShadow: 'none', bgcolor: 'rgba(0, 0, 0, 0.04)' }}
                >
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                      <HandymanIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                      <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                        {toolName}
                      </Typography>
                      <Chip
                        label={`ID: ${toolCall.id ? toolCall.id.substring(0, 8) : 'N/A'}...`}
                        size="small" color="default" variant="outlined"
                        sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                      />
                    </Box>
                  </AccordionSummary>
                  <AccordionDetails sx={{ p: 0, pl: 2, pr: 2, pb: 1 }}>
                    <Box component="pre" sx={{
                      bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
                      fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', // Ensure wrapping
                      wordBreak: 'break-word', // Ensure breaking
                    }}>
                      {formattedArgs}
                    </Box>
                  </AccordionDetails>
                </Accordion>
              );
            })}
          </Box>
        )}

        {/* Display tool call result for tool messages */}
        {message.role === 'tool' && message.tool_call_id && (
          <Box>
            <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', color: 'text.secondary', mb: 1 }}>
              <TerminalIcon fontSize="small" sx={{ mr: 1 }} />
              The tool responded to the assistant
            </Typography>

            <Accordion
              defaultExpanded={false} // dont Auto-expand the tool result
              sx={{ mb: 0.5, '&:before': { display: 'none' }, boxShadow: 'none', bgcolor: 'rgba(0, 0, 0, 0.02)' }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <TerminalIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
                  <Typography variant="subtitle2">Tool Result</Typography>
                  <Chip
                    label={`ID: ${message.tool_call_id.substring(0, 8)}...`}
                    size="small" color="default" variant="outlined"
                    sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                  />
                  {/* Add Toggle Switch */}
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={showRaw}
                        onChange={(e) => onToggleRaw(message.id, e.target.checked)}
                        onClick={(e) => e.stopPropagation()} // Prevent accordion toggle on switch click
                      />
                    }
                    label="Raw"
                    sx={{ mr: 1, ml: 'auto', '& .MuiTypography-root': { fontSize: '0.75rem' } }}
                    onClick={(e) => e.stopPropagation()} // Prevent accordion toggle on label click
                  />
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, pb: 1, overflow: 'hidden' }}>
                {showRaw ? (
                  // Show Raw Content
                  <Box
                    component="pre"
                    sx={{
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      fontSize: '0.8rem',
                      p: 1,
                      borderRadius: 1,
                      border: 1,
                      borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb',
                      bgcolor: 'action.hover',
                      color: (theme) => theme.palette.text.primary,
                      overflow: 'auto',
                      maxHeight: '300px', // Limit height
                    }}
                  >
                    {typeof message.content === 'string' ? message.content : '[Invalid tool content]'}
                  </Box>
                ) : (
                  // Show Rendered Content
                  <Box sx={{ width: '100%', minWidth: 0 }}>
                    {typeof message.content === 'string' ? (() => {
                      try {
                        const parsedContent = JSON.parse(message.content);
                        // Check for MCP content structure (directly under parsed object)
                        if (parsedContent && Array.isArray(parsedContent.content)) {
                          return (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              {parsedContent.content.map((item: any, index: number) => {
                                if (item.type === 'text') {
                                  return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>;
                                } else if (item.type === 'image' && item.data && item.mimeType) {
                                  return (
                                    <img
                                      key={index}
                                      src={`data:${item.mimeType};base64,${item.data}`}
                                      alt={`Tool Result Image ${index + 1}`}
                                      style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px', marginTop: '8px' }}
                                    />
                                  );
                                } else if (item.type === 'audio' && item.data && item.mimeType) {
                                  return (
                                    <audio
                                      key={index}
                                      controls
                                      src={`data:${item.mimeType};base64,${item.data}`}
                                      style={{ width: '100%', marginTop: '8px' }}
                                    >
                                      Your browser does not support the audio element.
                                    </audio>
                                  );
                                } else {
                                  // Fallback for unknown content types
                                  return (
                                    <Box
                                      key={index}
                                      component="pre"
                                      sx={{
                                        whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.8rem', p: 1,
                                        borderRadius: 1, border: 1, borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb',
                                        bgcolor: 'action.hover', color: (theme) => theme.palette.text.primary, overflow: 'auto', mt: 1
                                      }}
                                    >
                                      {`Unsupported content type: ${item.type}\n${JSON.stringify(item, null, 2)}`}
                                    </Box>
                                  );
                                }
                              })}
                            </Box>
                          );
                        } else {
                          // If JSON doesn't match expected structure (e.g., missing content array), render as formatted JSON
                          return <ReactMarkdown remarkPlugins={[remarkGfm]}>{`\`\`\`json\n${JSON.stringify(parsedContent, null, 2)}\n\`\`\``}</ReactMarkdown>;
                        }
                      } catch (e) {
                        // If parsing fails, render original string content as markdown
                        return <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>;
                      }
                    })() : (
                      <Typography variant="body2" fontStyle="italic" color="text.secondary">
                        [Invalid tool content]
                      </Typography>
                    )}
                  </Box>
                )}
              </AccordionDetails>
            </Accordion>
          </Box>
        )}

        {/* Display attachments if any */}
        {message.attachments && message.attachments.length > 0 && (
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              Attachments:
            </Typography>

            {message.attachments.map((attachment) => (
              attachment.type === 'image' ? (
                <Box key={attachment.id} sx={{ mb: 0.5 }}>
                  <img
                    src={attachment.content}
                    alt={attachment.originalName || 'image attachment'}
                    style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                  />
                </Box>
              ) : (
                <Box
                  key={attachment.id}
                  sx={{ display: 'flex', alignItems: 'center', p: 1, borderRadius: 1, bgcolor: 'rgba(0, 0, 0, 0.04)', mb: 0.5 }}
                >
                  {attachment.type === 'document' ? (
                    <AttachFileIcon fontSize="small" sx={{ mr: 1 }} />
                  ) : (
                    <MicIcon fontSize="small" sx={{ mr: 1 }} />
                  )}
                  {/* Ensure attachment names wrap */}
                  <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                    {attachment.originalName || `${attachment.type} attachment`}
                  </Typography>
                </Box>
              )
            ))}
          </Box>
        )}
      </Paper>
    </Box>
  );
});

const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  pendingToolCalls, // Destructure new prop
  availableNodes = [], // Destructure with default empty array
  conversationId,
  onToggleDisabled,
  onSplitConversation,
  onEditMessage,
  onApproveToolCall, // Destructure new prop
  onRejectToolCall // Destructure new prop
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // --- Render window (long-conversation performance) ---
  const [visibleCount, setVisibleCount] = useState<number>(MESSAGES_WINDOW_INITIAL);
  useEffect(() => {
    setVisibleCount(MESSAGES_WINDOW_INITIAL);
  }, [conversationId]);

  const totalCount = Array.isArray(messages) ? messages.length : 0;
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  const visibleMessages = useMemo(
    () => (Array.isArray(messages) ? (hiddenCount > 0 ? messages.slice(hiddenCount) : messages) : []),
    [messages, hiddenCount]
  );

  // Scroll to bottom only when a NEW last message arrives — not when an
  // existing message is updated in place, and not when the user expands the
  // window to read older messages.
  const lastMessageId = totalCount > 0 ? messages[totalCount - 1].id : undefined;
  const prevLastMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastMessageId === prevLastMessageIdRef.current) return;
    prevLastMessageIdRef.current = lastMessageId;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastMessageId]);

  // Message menu state
  const [menuAnchorEl, setMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [activeMessageId, setActiveMessageId] = React.useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState<boolean>(false);
  const [editContent, setEditContent] = React.useState<string>('');
  const [editNodeId, setEditNodeId] = React.useState<string | null>(null);
  // State to manage raw view toggle for each tool message
  const [showRawToolResult, setShowRawToolResult] = React.useState<Record<string, boolean>>({});

  // Stable callbacks handed to every (memoized) bubble.
  const handleMenuOpen = useCallback((event: React.MouseEvent<HTMLElement>, messageId: string) => {
    log.debug(`handleMenuOpen called with messageId: ${messageId}`);
    setMenuAnchorEl(event.currentTarget);
    setActiveMessageId(messageId);
  }, []);

  const handleToggleRaw = useCallback((messageId: string, checked: boolean) => {
    setShowRawToolResult(prev => ({ ...prev, [messageId]: checked }));
  }, []);

  const handleEditContentChange = useCallback((content: string) => {
    setEditContent(content);
  }, []);

  const handleEditNodeChange = useCallback((nodeId: string) => {
    // Always use the string value, never null
    setEditNodeId(nodeId);
  }, []);

  const handleMenuClose = () => {
    setMenuAnchorEl(null);
    setActiveMessageId(null);
  };

  const handleToggleDisabled = () => {
    if (activeMessageId) {
      onToggleDisabled(activeMessageId);
      handleMenuClose();
    }
  };

  const handleSplitConversation = () => {
    if (activeMessageId) {
      onSplitConversation(activeMessageId);
      handleMenuClose();
    }
  };

  const handleStartEditing = () => {
    if (activeMessageId) {
      const message = messages.find(m => m.id === activeMessageId);
      // Ensure content is a string before setting it for editing
      if (message && message.role === 'user' && typeof message.content === 'string') {
        setEditContent(message.content);
        // Use existing processNodeId or first available node if any, never null
        setEditNodeId(message.processNodeId || (availableNodes.length > 0 ? availableNodes[0].id : ""));
        setEditingMessageId(activeMessageId);
        setIsEditing(true);
      }
      handleMenuClose();
    }
  };

  const handleSaveEdit = () => {
    if (editingMessageId && onEditMessage) {
      // Always pass the string value of editNodeId, never null
      onEditMessage(editingMessageId, editContent, editNodeId || "");
      setIsEditing(false);
      setEditingMessageId(null);
      setEditNodeId(null);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditingMessageId(null);
    setEditNodeId(null);
  };

  // Resolve node ids to display labels once per availableNodes change.
  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of availableNodes) {
      map.set(node.id, node.label);
    }
    return map;
  }, [availableNodes]);

  // Find the active message *before* rendering the Menu
  // This avoids potential state timing issues within the IIFE
  const activeMsgForMenu = useMemo(() => {
    if (!activeMessageId) return null;
    return messages.find(m => m.id === activeMessageId) || null;
  }, [activeMessageId, messages]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Older messages are kept out of the DOM until requested */}
      {hiddenCount > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setVisibleCount(count => count + MESSAGES_WINDOW_STEP)}
          >
            Show earlier messages ({hiddenCount} more)
          </Button>
        </Box>
      )}

      {visibleMessages.map((message, index) => {
        const isThisEditing = isEditing && message.id === editingMessageId;
        return (
          <MessageBubble
            key={message.id || `msg-${hiddenCount + index}`} // Use message.id as key, fallback to global index
            message={message}
            nodeLabel={message.processNodeId ? nodeLabelById.get(message.processNodeId) : undefined}
            availableNodes={availableNodes}
            showRaw={!!showRawToolResult[message.id]}
            edit={isThisEditing ? { content: editContent, nodeId: editNodeId } : null}
            onMenuOpen={handleMenuOpen}
            onToggleRaw={handleToggleRaw}
            onEditContentChange={handleEditContentChange}
            onEditNodeChange={handleEditNodeChange}
            onSaveEdit={isThisEditing ? handleSaveEdit : undefined}
            onCancelEdit={isThisEditing ? handleCancelEdit : undefined}
          />
        );
      })}

      {/* Menu for message actions */}
      <Menu
        anchorEl={menuAnchorEl}
        open={Boolean(menuAnchorEl)}
        onClose={handleMenuClose}
      >
        {/* Use pre-calculated activeMsgForMenu */}
        {activeMsgForMenu && (() => {
          log.debug('Entering menu item rendering logic', { activeMessageId });
          log.debug('Active message object for menu:', activeMsgForMenu);
          log.debug('Active message role for menu:', activeMsgForMenu?.role);
          try {
            const hasOnEditMessageProp = !!onEditMessage;
            const shouldShowEdit = activeMsgForMenu.role === 'user' && hasOnEditMessageProp;

            log.debug('Rendering Edit Message menu item check', {
              activeMessageId: activeMsgForMenu.id, // Use ID from the message object
              messageRole: activeMsgForMenu.role,
              onEditMessagePropType: typeof onEditMessage,
              hasOnEditMessageProp,
              shouldShowEdit
            });

            if (shouldShowEdit) {
              return (
                <MenuItem onClick={handleStartEditing}>
                  <ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
                  <ListItemText>Edit Message</ListItemText>
                </MenuItem>
              );
            }
            return null;
          } catch (error) {
            log.error('Error rendering Edit Message menu item', { error });
            return null; // Return null on error
          }
        })()}

        {/* Other Menu Items - Use activeMsgForMenu if needed, or keep original logic if activeMessageId state is sufficient */}
        <MenuItem onClick={handleToggleDisabled}>
          <ListItemIcon><BlockIcon fontSize="small" /></ListItemIcon>
          <ListItemText>
            {/* Use activeMsgForMenu here as well for consistency */}
            {activeMsgForMenu?.disabled ? 'Enable Message' : 'Disable Message'}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleSplitConversation}>
          <ListItemIcon><CallSplitIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Split Conversation Here</ListItemText>
        </MenuItem>
      </Menu>

      {/* Invisible element to scroll to */}
      <div ref={messagesEndRef} />

      {/* Display Pending Tool Calls for Approval */}
      {/* Add null check for pendingToolCalls before accessing length */}
      {pendingToolCalls && pendingToolCalls.length > 0 && (
        <Paper
          elevation={2}
          sx={{ p: 2, mt: 2, bgcolor: 'warning.light', border: '1px solid', borderColor: 'warning.main', borderRadius: 2 }}
        >
          <Typography variant="h6" sx={{ mb: 1, display: 'flex', alignItems: 'center' }}>
            <HandymanIcon sx={{ mr: 1 }} /> Tool Approval Required
          </Typography>
          <Typography variant="body2" sx={{ mb: 2 }}>
            The assistant wants to use the following tool(s). Please approve or reject each request.
          </Typography>
          {pendingToolCalls.map((toolCall, ptcIndex) => { // Added index for key
            const toolName = displayToolName(toolCall.function.name);
            let formattedArgs = toolCall.function.arguments;
            try {
              const parsedArgs = JSON.parse(toolCall.function.arguments);
              formattedArgs = JSON.stringify(parsedArgs, null, 2);
            } catch (e) { /* Use original string */ }

            return (
              <Accordion
                key={toolCall.id || `ptc-${ptcIndex}`} // Use toolCall.id as key
                defaultExpanded={true} // Expand by default for approval
                sx={{ mb: 1, '&:before': { display: 'none' }, boxShadow: 1 }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                    <HandymanIcon fontSize="small" sx={{ mr: 1, color: 'primary.main' }} />
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold', flexGrow: 1 }}>
                      {toolName}
                    </Typography>
                    <Chip
                      label={`ID: ${toolCall.id ? toolCall.id.substring(0, 8) : 'N/A'}...`}
                      size="small" variant="outlined"
                      sx={{ ml: 1, height: 20, fontSize: '0.7rem' }}
                    />
                  </Box>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  <Box component="pre" sx={{
                    bgcolor: 'action.hover', p: 1, borderRadius: '4px', overflowX: 'auto', fontFamily: 'monospace',
                    fontSize: '0.75rem', my: 0.5, maxHeight: '150px', whiteSpace: 'pre-wrap', // Ensure wrapping
                    wordBreak: 'break-word', // Ensure breaking
                  }}>
                    {formattedArgs}
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
                    <Button
                      variant="outlined" color="error" size="small" startIcon={<ThumbDownIcon />}
                      onClick={() => onRejectToolCall && onRejectToolCall(toolCall.id)}
                      disabled={!onRejectToolCall}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="contained" color="success" size="small" startIcon={<ThumbUpIcon />}
                      onClick={() => onApproveToolCall && onApproveToolCall(toolCall.id)}
                      disabled={!onApproveToolCall}
                    >
                      Approve
                    </Button>
                  </Box>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </Paper>
      )}
    </Box>
  );
};

export default ChatMessages;
