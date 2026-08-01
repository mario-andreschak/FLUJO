"use client";

import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createLogger } from '@/utils/logger';
import { transcribe } from '@/frontend/services/transcription';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/Chat/ChatInput');
import {
  Box, 
  TextField, 
  IconButton, 
  Paper, 
  Tooltip, 
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  FormControlLabel, // Added for checkbox
  Checkbox, // Added for checkbox
  Chip,
  alpha,
  useTheme,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CheckIcon from '@mui/icons-material/Check';
import EditIcon from '@mui/icons-material/Edit';
import FlowNodePicker from './FlowNodePicker';
import { v4 as uuidv4 } from 'uuid';
import { Attachment } from './index';
import GlobalReferenceEditor from '@/frontend/components/shared/GlobalReferenceEditor';
import { mcpService } from '@/frontend/services/mcp';
import {
  createPromptReferenceSuggestion,
  PromptReferenceSuggestion,
} from '@/utils/shared/promptRefs';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface ChatInputProps {
  onSendMessage: (content: string, attachments: Attachment[]) => void;
  disabled?: boolean;
  placeholder?: string;
  // Add callback and state for the approval toggle
  requireApproval?: boolean;
  onRequireApprovalChange?: (checked: boolean) => void;
  // Add callback and state for the debugger toggle
  executeInDebugger?: boolean;
  onExecuteInDebuggerChange?: (checked: boolean) => void;
  // Node picker: nodes of the conversation's flow, the node the next message
  // will resume on, whether that node is a manual pick, and the pick callback
  // (null = back to automatic).
  availableNodes?: { id: string; label: string }[];
  /** Full flow definition, pre-rendered by the visual node picker. */
  flow?: import('@/shared/types/flow').Flow | null;
  currentNodeId?: string | null;
  nodeOverrideActive?: boolean;
  onSelectNode?: (nodeId: string | null) => void;
  // Edit mode: when set, the input edits an existing message (content + its
  // process node) instead of composing a new one. Editing happens here rather
  // than inline in the bubble.
  editing?: { messageId: string; content: string; nodeId: string | null } | null;
  onEditingContentChange?: (content: string) => void;
  onEditingNodeChange?: (nodeId: string | null) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  disabled = false,
  placeholder,
  requireApproval = false,
  onRequireApprovalChange,
  executeInDebugger = false, // Default to false
  onExecuteInDebuggerChange,
  availableNodes = [],
  flow = null,
  currentNodeId = null,
  nodeOverrideActive = false,
  onSelectNode,
  editing = null,
  onEditingContentChange,
  onEditingNodeChange,
  onSaveEdit,
  onCancelEdit
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  const { settings, globalEnvVars } = useStorage();
  const globalNames = useMemo(
    () => Object.entries(globalEnvVars)
      .filter(([, entry]) => !entry.metadata?.isSecret)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b)),
    [globalEnvVars],
  );
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingInterval, setRecordingInterval] = useState<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // For audio recording
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Visual node picker (modal) open state.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Editing an existing message vs. composing a new one. In edit mode the text
  // and picked node come from the parent; otherwise from local state.
  const isEditing = !!editing;
  const pickerSelectedId = isEditing ? (editing?.nodeId ?? null) : currentNodeId;
  const nodeLabelFor = (id: string | null) =>
    availableNodes.find(n => n.id === id)?.label
    || (id ? `${id.substring(0, 6)}...` : t('chat.input.startNode'));
  const currentNodeLabel = nodeLabelFor(pickerSelectedId);
  const handlePickNode = (nodeId: string | null) => {
    if (isEditing) onEditingNodeChange?.(nodeId);
    else onSelectNode?.(nodeId);
  };

  const [referenceSuggestions, setReferenceSuggestions] = useState<PromptReferenceSuggestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!flow) {
      setReferenceSuggestions([]);
      return () => { cancelled = true; };
    }

    const startNode = flow.nodes.find((candidate) => (candidate.data?.type ?? candidate.type) === 'start');
    const startTargetId = startNode
      ? flow.edges.find((edge) => edge.source === startNode.id && edge.data?.edgeType !== 'mcp')?.target
      : undefined;
    const processNodeId = pickerSelectedId
      ?? startTargetId
      ?? flow.nodes.find((candidate) => (candidate.data?.type ?? candidate.type) === 'process')?.id;
    if (!processNodeId) {
      setReferenceSuggestions([]);
      return () => { cancelled = true; };
    }

    const mcpNodeIds = new Set(flow.edges
      .filter((edge) => edge.data?.edgeType === 'mcp'
        && (edge.source === processNodeId || edge.target === processNodeId))
      .map((edge) => edge.source === processNodeId ? edge.target : edge.source));
    const contexts = flow.nodes
      .filter((candidate) => (candidate.data?.type ?? candidate.type) === 'mcp' && mcpNodeIds.has(candidate.id))
      .map((candidate) => ({
        server: candidate.data.properties?.boundServer as string | undefined,
        enabledTools: new Set<string>(candidate.data.properties?.enabledTools ?? []),
        enabledResources: candidate.data.properties?.enabledResources as string[] | 'all' | undefined,
      }))
      .filter((context): context is {
        server: string;
        enabledTools: Set<string>;
        enabledResources: string[] | 'all' | undefined;
      } => !!context.server);

    if (contexts.length === 0) {
      setReferenceSuggestions([]);
      return () => { cancelled = true; };
    }

    void Promise.all(contexts.map(async ({ server, enabledTools, enabledResources }) => {
      const suggestions: PromptReferenceSuggestion[] = [];
      try {
        const result = await mcpService.listServerTools(server);
        for (const tool of result.tools ?? []) {
          if (!tool?.name || !enabledTools.has(tool.name)) continue;
          suggestions.push(createPromptReferenceSuggestion(
            { kind: 'tool', server, name: tool.name },
            tool.name,
            tool.description || server,
          ));
        }
      } catch (error) {
        log.warn(`Failed to load chat @ tool suggestions for ${server}`, error);
      }
      try {
        const result = await mcpService.listServerResources(server);
        const isResourceEnabled = (uri: string) => enabledResources === undefined
          || enabledResources === 'all'
          || enabledResources.includes(uri);
        for (const resource of result.resources ?? []) {
          if (!isResourceEnabled(resource.uri)) continue;
          suggestions.push(createPromptReferenceSuggestion(
            { kind: 'resource', server, name: resource.uri },
            resource.name || resource.uri,
            resource.description || `${server} · ${resource.uri}`,
          ));
        }
        for (const resource of result.resourceTemplates ?? []) {
          if (!isResourceEnabled(resource.uriTemplate)) continue;
          suggestions.push(createPromptReferenceSuggestion(
            { kind: 'resource', server, name: resource.uriTemplate },
            resource.name || resource.uriTemplate,
            resource.description || `${server} · ${resource.uriTemplate}`,
          ));
        }
      } catch (error) {
        log.warn(`Failed to load chat @ resource suggestions for ${server}`, error);
      }
      return suggestions;
    })).then((groups) => {
      if (!cancelled) setReferenceSuggestions(groups.flat());
    });

    return () => { cancelled = true; };
  }, [flow, pickerSelectedId]);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogContent, setDialogContent] = useState('');
  const [dialogTitle, setDialogTitle] = useState('');
  const [dialogType, setDialogType] = useState<'document' | 'audio'>('document');
  const [pendingAudioDataUrl, setPendingAudioDataUrl] = useState<string | null>(null);
  const [pendingAudioMimeType, setPendingAudioMimeType] = useState<string | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Transcription state
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [transcriptionStatus, setTranscriptionStatus] = useState('');
  
  // Handle text input change (routes to the parent while editing).
  const handleMessageChange = (value: string) => {
    if (isEditing) onEditingContentChange?.(value);
    else setMessage(value);
  };

  // Save the in-progress edit (only when there's content).
  const handleSaveEdit = () => {
    if (editing && editing.content.trim()) onSaveEdit?.();
  };

  // Handle sending a message
  const handleSend = () => {
    if (message.trim() || attachments.length > 0) {
      log.debug('Sending message', { messageLength: message.length, attachmentsCount: attachments.length });
      onSendMessage(message, attachments);
      setMessage('');
      setAttachments([]);
    }
  };

  // Handle key press (Enter to send / save edit)
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isEditing) {
        handleSaveEdit();
      } else {
        log.debug('Enter key pressed, sending message');
        handleSend();
      }
    } else if (e.key === 'Escape' && isEditing) {
      e.preventDefault();
      onCancelEdit?.();
    }
  };

  // Handle pasting images (e.g. Ctrl+V of a screenshot) into the input. Each
  // pasted image is read as a data URL and added as an image attachment; when
  // images are found we preventDefault so the data URL text isn't also dumped
  // into the textbox. Non-image pastes fall through to the default behavior.
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length === 0) return; // let normal text paste proceed
    e.preventDefault();
    log.debug('Pasting image attachment(s)', { count: imageFiles.length });
    imageFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result;
        if (typeof dataUrl !== 'string') return;
        const ext = (file.type.split('/')[1] || 'png').split('+')[0];
        setAttachments(prev => [...prev, {
          id: uuidv4(),
          type: 'image',
          content: dataUrl,
          originalName: file.name && !/^image\.\w+$/i.test(file.name) ? file.name : `Pasted image.${ext}`,
        }]);
      };
      reader.onerror = () => log.error('Failed to read pasted image');
      reader.readAsDataURL(file);
    });
  };
  
  // Handle file selection
  const handleFileSelect = () => {
    log.debug('File selection triggered');
    fileInputRef.current?.click();
  };
  
  // Process selected file
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const file = files[0];
    log.debug('File selected', { fileName: file.name, fileSize: file.size, fileType: file.type });
    try {
      const mimeType = file.type || 'application/octet-stream';
      const isText =
        mimeType.startsWith('text/') ||
        /\.(txt|md|json|csv|html?|xml|js|ts|jsx|tsx|css|scss)$/i.test(file.name);
      if (!isText) {
        const dataUrl = await readFileAsDataUrl(file);
        const type: Attachment['type'] =
          mimeType.startsWith('image/') ? 'image'
            : mimeType.startsWith('audio/') ? 'audio'
              : mimeType.startsWith('video/') ? 'video'
                : 'document';
        setAttachments(prev => [...prev, {
          id: uuidv4(),
          type,
          content: dataUrl,
          originalName: file.name,
          mimeType,
        }]);
      } else {
        setDialogTitle(t('chat.input.processingFile', { file: file.name }));
        setDialogType('document');
        setDialogContent('');
        setIsProcessing(true);
        setDialogOpen(true);
        const text = await readFileAsText(file);
        log.debug('File read successfully', { contentLength: text.length });
        setDialogContent(text);
        setIsProcessing(false);
      }
    } catch (error) {
      log.error('Error reading file:', error);
      setDialogContent(t('chat.input.readFailed'));
      setIsProcessing(false);
    }
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // Read file as text
  const readFileAsText = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (event) => {
        if (event.target?.result) {
          resolve(event.target.result as string);
        } else {
          reject(new Error('Failed to read file'));
        }
      };
      
      reader.onerror = () => {
        reject(new Error('Error reading file'));
      };
      
      reader.readAsText(file);
    });
  };

  const readFileAsDataUrl = (file: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Failed to encode file'));
      reader.onerror = () => reject(new Error('Error reading file'));
      reader.readAsDataURL(file);
    });
  
  // Start audio recording
  const startRecording = async () => {
    log.debug('Starting audio recording');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log.debug('Audio stream obtained successfully');
      
      // Reset audio chunks
      audioChunksRef.current = [];
      
      // Create media recorder
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      
      // Handle data available event
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      // Handle recording stop
      mediaRecorder.onstop = async () => {
        // Create blob from chunks
        const recordedMime = mediaRecorder.mimeType || audioChunksRef.current[0]?.type || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: recordedMime });
        
        // Start the dialog with loading state
        setDialogTitle(t('chat.input.audioRecording'));
        setDialogType('audio');
        setPendingAudioDataUrl(await readFileAsDataUrl(audioBlob));
        setPendingAudioMimeType(recordedMime);
        setDialogContent(''); // Clear any previous content
        setIsProcessing(true);
        setDialogOpen(true);
        
        try {
          // Get speech settings from storage
          const speechSettings = settings?.speech || {
            enabled: true,
            modelSize: 'base',
            autoDownload: false
          };
          
          if (speechSettings.enabled) {
            // Use the new transcription service
            setTranscriptionStatus(t('chat.input.initializingTranscription'));
            setTranscriptionProgress(0);
            
            const result = await transcribe(audioBlob, {
              onProgress: setTranscriptionProgress,
              onStatusChange: setTranscriptionStatus,
              language: navigator.language
            });
            
            if (result.success) {
              // Set transcription result
              const resultText = result.text;
              
              // Add a note that it was transcribed using Web Speech API
              // resultText += '\n\n(Transcribed using browser speech recognition)';
              
              setDialogContent(resultText);
              log.debug('Transcription successful', {
                textLength: result.text.length,
                engine: result.engine
              });
            } else {
              // Handle error
              setDialogContent(t('chat.input.transcriptionFailed', { error: result.error || t('common.unknownError') }));
              log.error('Transcription failed', { error: result.error });
            }
          } else {
            // Fallback message if speech recognition is disabled
            setDialogContent(t('chat.input.speechDisabled'));
          }
        } catch (error) {
          log.error('Error handling audio recording', { error });
          setDialogContent(t('chat.input.audioFailed', { error: String(error) }));
        } finally {
          setIsProcessing(false);
          
          // Stop all tracks
          stream.getTracks().forEach(track => track.stop());
        }
      };
      
      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
      
      // Start timer
      const interval = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
      setRecordingInterval(interval);
      
    } catch (error) {
      log.error('Error starting recording:', error);
      alert(t('chat.input.microphoneFailed'));
    }
  };
  
  // Stop audio recording
  const stopRecording = () => {
    log.debug('Stopping audio recording');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      // Clear timer
      if (recordingInterval) {
        clearInterval(recordingInterval);
        setRecordingInterval(null);
      }
      
      setRecordingTime(0);
    }
  };
  
  // Format recording time
  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };
  
  // Add attachment from dialog
  const handleAddAttachment = () => {
    log.debug('Adding attachment', { type: dialogType, titleLength: dialogTitle.length });
    const newAttachment: Attachment = {
      id: uuidv4(),
      type: dialogType,
      content: dialogType === 'audio' && pendingAudioDataUrl
        ? pendingAudioDataUrl
        : dialogContent,
      originalName: dialogTitle,
      ...(dialogType === 'audio' && pendingAudioMimeType
        ? { mimeType: pendingAudioMimeType, transcript: dialogContent }
        : {}),
    };
    
    setAttachments([...attachments, newAttachment]);
    setPendingAudioDataUrl(null);
    setPendingAudioMimeType(undefined);
    setDialogOpen(false);
  };
  
  // Remove attachment
  const handleRemoveAttachment = (id: string) => {
    log.debug('Removing attachment', { id });
    setAttachments(attachments.filter(att => att.id !== id));
  };
  
  return (
    <>
      <Paper 
        elevation={0}
        sx={{ 
          width: '100%',
          maxWidth: 'none',
          mx: 0,
          p: { xs: 1, sm: 1.25 },
          display: 'flex', 
          flexDirection: 'column',
          border: `1px solid ${alpha(theme.palette.primary.main, 0.24)}`,
          borderRadius: 0,
          bgcolor: alpha(theme.palette.background.paper, theme.palette.mode === 'dark' ? 0.82 : 0.92),
          boxShadow: `0 22px 70px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.34 : 0.12)}, 0 0 0 1px ${alpha(theme.palette.common.white, 0.03)} inset`,
          backdropFilter: 'blur(24px) saturate(145%)',
        }}
      >
        {/* Attachments display */}
        {attachments.length > 0 && (
          <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {attachments.map((attachment) => (
              <Paper
                key={attachment.id}
                variant="outlined"
                sx={{ 
                  p: 1, 
                  display: 'flex', 
                  alignItems: 'center',
                  borderRadius: 1,
                  bgcolor: 'background.default'
                }}
              >
                {attachment.type === 'image' ? (
                  <Box
                    component="img"
                    src={attachment.content}
                    alt={attachment.originalName || t('chat.input.pastedImage')}
                    sx={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 1, mr: 1 }}
                  />
                ) : attachment.type === 'video' ? (
                  <Box
                    component="video"
                    src={attachment.content}
                    sx={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 1, mr: 1 }}
                  />
                ) : attachment.type === 'document' ? (
                  <AttachFileIcon fontSize="small" sx={{ mr: 1 }} />
                ) : (
                  <MicIcon fontSize="small" sx={{ mr: 1 }} />
                )}
                <Typography variant="body2" noWrap sx={{ maxWidth: 150 }}>
                  {attachment.originalName || t('chat.input.attachment', { type: attachment.type })}
                </Typography>
                <IconButton 
                  size="small" 
                  onClick={() => handleRemoveAttachment(attachment.id)}
                  sx={{ ml: 1 }}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Paper>
            ))}
          </Box>
        )}
        
        {/* Edit banner: shown while editing an existing message in the input. */}
        {isEditing && (
          <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip icon={<EditIcon />} label={t('chat.input.editing')} size="small" color="warning" variant="outlined" />
            <Typography variant="caption" color="text.secondary">
              {t('chat.input.editKeys')}
            </Typography>
          </Box>
        )}

        {/* Input area */}
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.35 }}>
          <GlobalReferenceEditor
            value={isEditing ? (editing?.content ?? '') : message}
            onChange={handleMessageChange}
            globalNames={globalNames}
            suggestions={referenceSuggestions}
            multiline
            minRows={1}
            maxRows={isEditing ? 12 : 4}
            dataTour="chat-input"
            ariaLabel={isEditing ? t('chat.input.editMessage') : t('chat.input.message')}
            placeholder={isEditing ? t('chat.input.editPlaceholder') : (placeholder || t('chat.input.placeholder'))}
            onKeyDown={handleKeyPress}
            onPaste={handlePaste}
            disabled={isEditing ? false : disabled}
            autoFocus={isEditing}
            containerSx={{ flex: 1 }}
          />

          {/* Compose-only controls (attachments, audio) are hidden while editing. */}
          {!isEditing && (
            <>
          {/* File attachment button */}
          <Tooltip title={t('chat.input.attach')}>
            <IconButton
              color="primary"
              onClick={handleFileSelect}
              disabled={disabled || isRecording}
            >
              <AttachFileIcon />
            </IconButton>
          </Tooltip>

          {/* Hidden file input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: 'none' }}
            accept="image/*,audio/*,video/*,.pdf,.txt,.md,.json,.csv,.html,.xml,.js,.ts,.jsx,.tsx,.css,.scss"
          />

          {/* Audio recording button */}
          <Tooltip title={isRecording ? t('chat.input.stopRecording') : t('chat.input.recordAudio')}>
            <IconButton
              color={isRecording ? "error" : "primary"}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={disabled}
            >
              <MicIcon />
              {isRecording && (
                <Typography
                  variant="caption"
                  sx={{
                    position: 'absolute',
                    bottom: -15,
                    fontSize: '0.7rem',
                    color: 'error.main'
                  }}
                >
                  {formatRecordingTime(recordingTime)}
                </Typography>
              )}
            </IconButton>
          </Tooltip>
            </>
          )}

          {isEditing ? (
            <>
              {/* Save / cancel the edit */}
              <Tooltip title={t('chat.input.saveEdit')}>
                <span>
                  <IconButton
                    color="primary"
                    aria-label={t('chat.input.saveEdit')}
                    onClick={handleSaveEdit}
                    disabled={!editing?.content.trim()}
                  >
                    <CheckIcon />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('chat.input.cancelEdit')}>
                <IconButton color="default" aria-label={t('chat.input.cancelEdit')} onClick={() => onCancelEdit?.()}>
                  <CloseIcon />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            /* Send button */
            <Tooltip title={t('chat.input.send')}>
              <span>
                <IconButton
                  color="primary"
                  onClick={handleSend}
                  disabled={disabled || (!message.trim() && attachments.length === 0)}
                  aria-label={t('chat.input.send')}
                  sx={{
                    width: 44,
                    height: 44,
                    color: '#fff',
                    background: `linear-gradient(135deg, ${theme.palette.primary.light}, ${theme.palette.primary.main} 58%, ${theme.palette.secondary.main})`,
                    boxShadow: `0 10px 24px ${alpha(theme.palette.primary.main, 0.28)}`,
                    '&:hover': {
                      background: `linear-gradient(135deg, ${theme.palette.primary.light}, ${theme.palette.primary.main} 48%, ${theme.palette.secondary.main})`,
                      boxShadow: `0 14px 30px ${alpha(theme.palette.primary.main, 0.38)}`,
                    },
                    '&.Mui-disabled': {
                      color: 'text.disabled',
                      background: alpha(theme.palette.text.disabled, 0.12),
                      boxShadow: 'none',
                    },
                  }}
                >
                  <SendIcon />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box> {/* End of Input area Box */}

        {/* Run options: current-node pill + tool approval + execute-in-debugger */}
        {(onRequireApprovalChange || ((onSelectNode || isEditing) && availableNodes.length > 0)) && (
          <Box
            sx={{
              mt: 1,
              pt: 1,
              display: 'flex',
              justifyContent: 'flex-start',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 1,
              borderTop: 1,
              borderColor: 'divider',
            }}
          >
            {/* Node picker: shows the node this turn runs on; click to open the
                visual picker and choose a node from the pre-rendered flow. */}
            {(onSelectNode || isEditing) && availableNodes.length > 0 && (
              <>
                <Tooltip title={isEditing
                  ? t('chat.input.nodeEditing')
                  : (nodeOverrideActive
                    ? t('chat.input.nodeOverride')
                    : t('chat.input.nodeAutomatic'))}>
                  <Chip
                    icon={<AccountTreeIcon />}
                    label={currentNodeLabel}
                    size="small"
                    color={(isEditing || nodeOverrideActive) ? 'primary' : 'default'}
                    variant={(isEditing || nodeOverrideActive) ? 'filled' : 'outlined'}
                    onClick={() => setPickerOpen(true)}
                    disabled={isEditing ? false : disabled}
                  />
                </Tooltip>
                <FlowNodePicker
                  open={pickerOpen}
                  flow={flow}
                  selectedNodeId={pickerSelectedId}
                  allowAutomatic={!isEditing}
                  onSelect={handlePickNode}
                  onClose={() => setPickerOpen(false)}
                />
              </>
            )}
            {onRequireApprovalChange && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={requireApproval}
                  onChange={(e) => onRequireApprovalChange(e.target.checked)}
                  size="small"
                  disabled={disabled}
                />
              }
              label={<Typography variant="caption">{t('chat.input.requireApprovals')}</Typography>}
              sx={{ mr: 'auto' }} // Push to the left
            />
            )}
            {/* Debugger Checkbox */}
            {onExecuteInDebuggerChange && ( // Only show if callback is provided
              <FormControlLabel
                control={
                  <Checkbox
                    checked={executeInDebugger}
                    onChange={(e) => onExecuteInDebuggerChange(e.target.checked)}
                    size="small"
                    disabled={disabled}
                  />
                }
                label={<Typography variant="caption">{t('chat.input.debugger')}</Typography>}
                sx={{ ml: 2 }} // Add some margin to separate from the other checkbox
              />
            )}
          </Box>
        )} {/* End of Checkboxes Box */}
      </Paper> {/* End of main Paper component */}

      {/* Dialog for attachment preview/editing */}
      <Dialog
        open={dialogOpen}
        onClose={() => !isProcessing && setDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {dialogTitle}
          {!isProcessing && (
            <IconButton
              aria-label={t('common.close')}
              onClick={() => setDialogOpen(false)}
              sx={{
                position: 'absolute',
                right: 8,
                top: 8,
              }}
            >
              <CloseIcon />
            </IconButton>
          )}
        </DialogTitle>
        <DialogContent dividers>
          {isProcessing ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', flexDirection: 'column', alignItems: 'center', p: 4 }}>
              <CircularProgress
                value={dialogType === 'audio' && transcriptionProgress ? transcriptionProgress : undefined}
                variant={dialogType === 'audio' && transcriptionProgress > 0 ? 'determinate' : 'indeterminate'}
              />
              {dialogType === 'audio' && (
                <Box sx={{ mt: 2, textAlign: 'center' }}>
                  <Typography variant="body2">
                    {transcriptionStatus || t('chat.input.processingAudio')}
                  </Typography>
                  {transcriptionProgress > 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      {Math.round(transcriptionProgress)}%
                    </Typography>
                  )}
                </Box>
              )}
            </Box>
          ) : (
            <TextField
              multiline
              fullWidth
              minRows={10}
              maxRows={20}
              value={dialogContent}
              onChange={(e) => setDialogContent(e.target.value)}
              variant="outlined"
              placeholder={dialogType === 'document' ? t('chat.input.documentContent') : t('chat.input.audioTranscription')}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setDialogOpen(false)} 
            disabled={isProcessing}
          >
            {t('common.cancel')}
          </Button>
          <Button 
            onClick={handleAddAttachment} 
            variant="contained" 
            disabled={isProcessing || !dialogContent.trim()}
          >
            {t('chat.input.addToMessage')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ChatInput;
