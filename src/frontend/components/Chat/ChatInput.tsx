"use client";

import React, { useState, useRef } from 'react';
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
  Checkbox // Added for checkbox
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import MicIcon from '@mui/icons-material/Mic';
import CloseIcon from '@mui/icons-material/Close';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { Attachment } from './index';

interface ChatInputProps {
  onSendMessage: (content: string, attachments: Attachment[]) => void;
  disabled?: boolean;
  // Add callback and state for the approval toggle
  requireApproval?: boolean;
  onRequireApprovalChange?: (checked: boolean) => void;
  // Add callback and state for the debugger toggle
  executeInDebugger?: boolean;
  onExecuteInDebuggerChange?: (checked: boolean) => void;
}

const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  disabled = false,
  requireApproval = false,
  onRequireApprovalChange,
  executeInDebugger = false, // Default to false
  onExecuteInDebuggerChange
}) => {
  const { settings } = useStorage();
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordingInterval, setRecordingInterval] = useState<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // For audio recording
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogContent, setDialogContent] = useState('');
  const [dialogTitle, setDialogTitle] = useState('');
  const [dialogType, setDialogType] = useState<'document' | 'audio'>('document');
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Transcription state
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [transcriptionStatus, setTranscriptionStatus] = useState('');
  
  // Handle text input change
  const handleMessageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessage(e.target.value);
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
  
  // Handle key press (Enter to send)
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      log.debug('Enter key pressed, sending message');
      e.preventDefault();
      handleSend();
    }
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
    setDialogTitle(`Processing ${file.name}`);
    setDialogType('document');
    setDialogContent('');
    setIsProcessing(true);
    setDialogOpen(true);
    
    try {
      // Read file as text
      const text = await readFileAsText(file);
      log.debug('File read successfully', { contentLength: text.length });
      setDialogContent(text);
      setIsProcessing(false);
    } catch (error) {
      log.error('Error reading file:', error);
      setDialogContent('Error reading file. Please try again with a text file.');
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
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        
        // Start the dialog with loading state
        setDialogTitle('Audio Recording');
        setDialogType('audio');
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
            setTranscriptionStatus('Initializing transcription...');
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
              setDialogContent(`Error transcribing audio: ${result.error}.`);
              log.error('Transcription failed', { error: result.error });
            }
          } else {
            // Fallback message if speech recognition is disabled
            setDialogContent('Speech recognition is disabled in settings. Enable it to get automatic transcriptions.');
          }
        } catch (error) {
          log.error('Error handling audio recording', { error });
          setDialogContent(`Failed to process audio: ${error}`);
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
      alert('Could not access microphone. Please check permissions.');
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
      content: dialogContent,
      originalName: dialogTitle
    };
    
    setAttachments([...attachments, newAttachment]);
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
        elevation={3} 
        sx={{ 
          p: 2, 
          display: 'flex', 
          flexDirection: 'column',
          borderRadius: 2
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
                {attachment.type === 'document' ? (
                  <AttachFileIcon fontSize="small" sx={{ mr: 1 }} />
                ) : (
                  <MicIcon fontSize="small" sx={{ mr: 1 }} />
                )}
                <Typography variant="body2" noWrap sx={{ maxWidth: 150 }}>
                  {attachment.originalName || `${attachment.type} attachment`}
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
        
        {/* Input area */}
        <Box sx={{ display: 'flex', alignItems: 'flex-end' }}>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            placeholder="Type a message..."
            value={message}
            onChange={handleMessageChange}
            onKeyDown={handleKeyPress}
            disabled={disabled}
            variant="outlined"
            sx={{ mr: 1 }}
            InputProps={{
              sx: { borderRadius: 2 }
            }}
          />
          
          {/* File attachment button */}
          <Tooltip title="Attach document">
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
            accept=".txt,.md,.json,.csv,.html,.xml,.js,.ts,.jsx,.tsx,.css,.scss"
          />
          
          {/* Audio recording button */}
          <Tooltip title={isRecording ? "Stop recording" : "Record audio"}>
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
          
          {/* Send button */}
          <Tooltip title="Send message">
            <IconButton 
              color="primary" 
              onClick={handleSend}
              disabled={disabled || (!message.trim() && attachments.length === 0)}
            >
              <SendIcon />
            </IconButton>
          </Tooltip>
        </Box> {/* End of Input area Box */}

        {/* Tool Approval Checkbox */}
        {onRequireApprovalChange && ( // Only show if callback is provided
          <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-start' }}>
            <FormControlLabel
              control={
                <Checkbox
                  checked={requireApproval}
                  onChange={(e) => onRequireApprovalChange(e.target.checked)}
                  size="small"
                  disabled={disabled}
                />
              }
              label={<Typography variant="caption">Require Tool Approvals</Typography>}
              sx={{ mr: 'auto' }} // Push to the left
            />
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
                label={<Typography variant="caption">Execute in Debugger</Typography>}
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
              aria-label="close"
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
                    {transcriptionStatus || 'Processing audio...'}
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
              placeholder={dialogType === 'document' ? 'Document content' : 'Audio transcription'}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button 
            onClick={() => setDialogOpen(false)} 
            disabled={isProcessing}
          >
            Cancel
          </Button>
          <Button 
            onClick={handleAddAttachment} 
            variant="contained" 
            disabled={isProcessing || !dialogContent.trim()}
          >
            Add to Message
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default ChatInput;
