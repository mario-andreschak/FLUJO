"use client";

import React, { useState, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  Alert,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  CircularProgress,
  Paper,
  Divider,
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';

const log = createLogger('frontend/components/Settings/BackupSettings');

// Define backup options
interface BackupOption {
  key: string;
  label: string;
  description: string;
  storageKey?: StorageKey;
  isFolder?: boolean;
}

const backupOptions: BackupOption[] = [
  { key: 'models', label: 'Models', description: 'AI model configurations', storageKey: StorageKey.MODELS },
  { key: 'mcpServers', label: 'MCP Servers Configuration', description: 'MCP server settings', storageKey: StorageKey.MCP_SERVERS },
  { key: 'mcpServersFolder', label: 'MCP Servers Folder', description: 'MCP server code and files', isFolder: true },
  { key: 'flows', label: 'Flows', description: 'Flow configurations', storageKey: StorageKey.FLOWS },
  { key: 'chatHistory', label: 'Chat History', description: 'Conversation history', storageKey: StorageKey.CHAT_HISTORY },
  { key: 'settings', label: 'Settings', description: 'Application settings', storageKey: StorageKey.THEME },
  { key: 'globalEnvVars', label: 'Global Environment Variables', description: 'Global environment variables', storageKey: StorageKey.GLOBAL_ENV_VARS },
  { key: 'encryptionKey', label: 'Encryption Key', description: 'Data encryption key', storageKey: StorageKey.ENCRYPTION_KEY },
];

export default function BackupSettings() {
  // State for selected options
  const [backupSelections, setBackupSelections] = useState<Record<string, boolean>>(
    backupOptions.reduce((acc, option) => ({ ...acc, [option.key]: true }), {})
  );
  const [restoreSelections, setRestoreSelections] = useState<Record<string, boolean>>(
    backupOptions.reduce((acc, option) => ({ ...acc, [option.key]: true }), {})
  );
  
  // State for file handling
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // UI state
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  
  // Handle checkbox changes
  const handleBackupCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setBackupSelections({
      ...backupSelections,
      [event.target.name]: event.target.checked,
    });
  };
  
  const handleRestoreCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRestoreSelections({
      ...restoreSelections,
      [event.target.name]: event.target.checked,
    });
  };
  
  // Handle file selection
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
      setMessage(null);
    }
  };
  
  // Create backup
  const handleBackup = async () => {
    log.debug('Creating backup with selections:', backupSelections);
    setIsLoading(true);
    setMessage(null);
    
    try {
      // Get selected options
      const selectedOptions = Object.entries(backupSelections)
        .filter(([_, selected]) => selected)
        .map(([key]) => key);
      
      if (selectedOptions.length === 0) {
        setMessage({
          type: 'error',
          text: 'Please select at least one item to backup',
        });
        setIsLoading(false);
        return;
      }
      
      // Create the backup
      const response = await fetch('/api/backup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ selections: selectedOptions }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to create backup');
      }
      
      // Get the backup as a blob
      const blob = await response.blob();
      
      // Create a download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      
      // Generate filename with date
      const date = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      a.download = `flujo-backup-${date}.zip`;
      
      // Trigger download
      document.body.appendChild(a);
      a.click();
      
      // Cleanup
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      setMessage({
        type: 'success',
        text: 'Backup created successfully',
      });
    } catch (error) {
      log.error('Error creating backup:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to create backup',
      });
    } finally {
      setIsLoading(false);
    }
  };
  
  // Restore from backup
  const handleRestore = () => {
    if (!selectedFile) {
      setMessage({
        type: 'error',
        text: 'Please select a backup file',
      });
      return;
    }
    
    // Get selected options
    const selectedOptions = Object.entries(restoreSelections)
      .filter(([_, selected]) => selected)
      .map(([key]) => key);
    
    if (selectedOptions.length === 0) {
      setMessage({
        type: 'error',
        text: 'Please select at least one item to restore',
      });
      return;
    }
    
    // Show confirmation dialog
    setShowRestoreConfirm(true);
  };
  
  // Confirm restore
  const confirmRestore = async () => {
    log.debug('Restoring from backup with selections:', restoreSelections);
    setIsLoading(true);
    setMessage(null);
    setShowRestoreConfirm(false);
    
    try {
      // Get selected options
      const selectedOptions = Object.entries(restoreSelections)
        .filter(([_, selected]) => selected)
        .map(([key]) => key);
      
      // Create form data
      const formData = new FormData();
      formData.append('file', selectedFile as File);
      formData.append('selections', JSON.stringify(selectedOptions));
      
      // Upload the backup
      const response = await fetch('/api/restore', {
        method: 'POST',
        body: formData,
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to restore from backup');
      }
      
      setMessage({
        type: 'success',
        text: 'Restore completed successfully. You may need to refresh the page to see the changes.',
      });
      
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setSelectedFile(null);
    } catch (error) {
      log.error('Error restoring from backup:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to restore from backup',
      });
    } finally {
      setIsLoading(false);
    }
  };
  
  // Select/deselect all options
  const selectAllBackup = (select: boolean) => {
    const newSelections = { ...backupSelections };
    backupOptions.forEach(option => {
      newSelections[option.key] = select;
    });
    setBackupSelections(newSelections);
  };
  
  const selectAllRestore = (select: boolean) => {
    const newSelections = { ...restoreSelections };
    backupOptions.forEach(option => {
      newSelections[option.key] = select;
    });
    setRestoreSelections(newSelections);
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Typography variant="h6" gutterBottom>
        Backup and Restore
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Create backups of your application data or restore from a previous backup.
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}

      {/* Backup Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" gutterBottom fontWeight="bold">
          Create Backup
        </Typography>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Select the components you want to include in the backup.
        </Typography>
        
        <Box sx={{ mb: 2 }}>
          <Button 
            size="small" 
            onClick={() => selectAllBackup(true)}
            sx={{ mr: 1 }}
          >
            Select All
          </Button>
          <Button 
            size="small" 
            onClick={() => selectAllBackup(false)}
          >
            Deselect All
          </Button>
        </Box>
        
        <FormGroup sx={{ mb: 3 }}>
          {backupOptions.map((option) => (
            <FormControlLabel
              key={option.key}
              control={
                <Checkbox
                  checked={backupSelections[option.key]}
                  onChange={handleBackupCheckboxChange}
                  name={option.key}
                />
              }
              label={
                <Box>
                  <Typography variant="body1">{option.label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {option.description}
                  </Typography>
                </Box>
              }
            />
          ))}
        </FormGroup>
        
        <Button
          variant="contained"
          onClick={handleBackup}
          disabled={isLoading || Object.values(backupSelections).every(v => !v)}
          startIcon={isLoading ? <CircularProgress size={20} /> : null}
        >
          {isLoading ? 'Creating Backup...' : 'Create Backup'}
        </Button>
      </Paper>

      {/* Restore Section */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="subtitle1" gutterBottom fontWeight="bold">
          Restore from Backup
        </Typography>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Select a backup file and choose which components to restore.
        </Typography>
        
        <Box sx={{ mb: 3 }}>
          <Button
            variant="outlined"
            component="label"
            sx={{ mb: 2 }}
          >
            Select Backup File
            <input
              type="file"
              hidden
              accept=".zip"
              onChange={handleFileSelect}
              ref={fileInputRef}
            />
          </Button>
          
          {selectedFile && (
            <Typography variant="body2" sx={{ ml: 1 }}>
              Selected file: {selectedFile.name}
            </Typography>
          )}
        </Box>
        
        <Divider sx={{ mb: 2 }} />
        
        <Typography variant="subtitle2" gutterBottom>
          Restore Options
        </Typography>
        
        <Box sx={{ mb: 2 }}>
          <Button 
            size="small" 
            onClick={() => selectAllRestore(true)}
            sx={{ mr: 1 }}
          >
            Select All
          </Button>
          <Button 
            size="small" 
            onClick={() => selectAllRestore(false)}
          >
            Deselect All
          </Button>
        </Box>
        
        <FormGroup sx={{ mb: 3 }}>
          {backupOptions.map((option) => (
            <FormControlLabel
              key={option.key}
              control={
                <Checkbox
                  checked={restoreSelections[option.key]}
                  onChange={handleRestoreCheckboxChange}
                  name={option.key}
                />
              }
              label={
                <Box>
                  <Typography variant="body1">{option.label}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {option.description}
                  </Typography>
                </Box>
              }
            />
          ))}
        </FormGroup>
        
        <Button
          variant="contained"
          color="warning"
          onClick={handleRestore}
          disabled={isLoading || !selectedFile || Object.values(restoreSelections).every(v => !v)}
          startIcon={isLoading ? <CircularProgress size={20} /> : null}
        >
          {isLoading ? 'Restoring...' : 'Restore from Backup'}
        </Button>
      </Paper>

      {/* Confirmation Dialog */}
      <Dialog
        open={showRestoreConfirm}
        onClose={() => setShowRestoreConfirm(false)}
      >
        <DialogTitle>Confirm Restore</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will overwrite your existing data with the contents of the backup file.
            This action cannot be undone. Are you sure you want to continue?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowRestoreConfirm(false)}>Cancel</Button>
          <Button onClick={confirmRestore} color="warning" variant="contained">
            Restore
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
