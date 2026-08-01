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
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';

const log = createLogger('frontend/components/Settings/BackupSettings');

// Define backup options
interface BackupOption {
  key: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  storageKey?: StorageKey;
  isFolder?: boolean;
}

const backupOptions: BackupOption[] = [
  { key: 'models', labelKey: 'settings.backup.option.models', descriptionKey: 'settings.backup.option.modelsDescription', storageKey: StorageKey.MODELS },
  { key: 'mcpServers', labelKey: 'settings.backup.option.servers', descriptionKey: 'settings.backup.option.serversDescription', storageKey: StorageKey.MCP_SERVERS },
  { key: 'mcpServersFolder', labelKey: 'settings.backup.option.serverFiles', descriptionKey: 'settings.backup.option.serverFilesDescription', isFolder: true },
  { key: 'flows', labelKey: 'settings.backup.option.flows', descriptionKey: 'settings.backup.option.flowsDescription', storageKey: StorageKey.FLOWS },
  { key: 'chatHistory', labelKey: 'settings.backup.option.history', descriptionKey: 'settings.backup.option.historyDescription', storageKey: StorageKey.CHAT_HISTORY },
  { key: 'settings', labelKey: 'settings.backup.option.settings', descriptionKey: 'settings.backup.option.settingsDescription', storageKey: StorageKey.THEME },
  { key: 'globalEnvVars', labelKey: 'settings.backup.option.globals', descriptionKey: 'settings.backup.option.globalsDescription', storageKey: StorageKey.GLOBAL_ENV_VARS },
  { key: 'encryptionKey', labelKey: 'settings.backup.option.encryption', descriptionKey: 'settings.backup.option.encryptionDescription', storageKey: StorageKey.ENCRYPTION_KEY },
];

export default function BackupSettings() {
  const { t } = useI18n();
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
          text: t('settings.backup.selectOne'),
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
        throw new Error(t('settings.backup.createFailed'));
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
        text: t('settings.backup.created'),
      });
    } catch (error) {
      log.error('Error creating backup:', error);
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : t('settings.backup.createFailed'),
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
        text: t('settings.backup.fileRequired'),
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
        text: t('settings.backup.selectRestoreOne'),
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
        throw new Error(errorData.error || t('settings.backup.restoreFailed'));
      }
      
      setMessage({
        type: 'success',
        text: t('settings.backup.restored'),
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
        text: error instanceof Error ? error.message : t('settings.backup.restoreFailed'),
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
        {t('settings.backup.title')}
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('settings.backup.description')}
      </Typography>

      {message && (
        <Alert severity={message.type} sx={{ mb: 2 }}>
          {message.text}
        </Alert>
      )}

      {/* Backup Section */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" gutterBottom fontWeight="bold">
          {t('settings.backup.create')}
        </Typography>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('settings.backup.createHelp')}
        </Typography>
        
        <Box sx={{ mb: 2 }}>
          <Button 
            size="small" 
            onClick={() => selectAllBackup(true)}
            sx={{ mr: 1 }}
          >
            {t('settings.backup.selectAll')}
          </Button>
          <Button 
            size="small" 
            onClick={() => selectAllBackup(false)}
          >
            {t('settings.backup.deselectAll')}
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
                  <Typography variant="body1">{t(option.labelKey)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t(option.descriptionKey)}
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
          {isLoading ? t('settings.backup.creating') : t('settings.backup.create')}
        </Button>
      </Paper>

      {/* Restore Section */}
      <Paper sx={{ p: 3 }}>
        <Typography variant="subtitle1" gutterBottom fontWeight="bold">
          {t('settings.backup.restore')}
        </Typography>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('settings.backup.restoreHelp')}
        </Typography>
        
        <Box sx={{ mb: 3 }}>
          <Button
            variant="outlined"
            component="label"
            sx={{ mb: 2 }}
          >
            {t('settings.backup.selectFile')}
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
              {t('settings.backup.selectedFile', { name: selectedFile.name })}
            </Typography>
          )}
        </Box>
        
        <Divider sx={{ mb: 2 }} />
        
        <Typography variant="subtitle2" gutterBottom>
          {t('settings.backup.restoreOptions')}
        </Typography>
        
        <Box sx={{ mb: 2 }}>
          <Button 
            size="small" 
            onClick={() => selectAllRestore(true)}
            sx={{ mr: 1 }}
          >
            {t('settings.backup.selectAll')}
          </Button>
          <Button 
            size="small" 
            onClick={() => selectAllRestore(false)}
          >
            {t('settings.backup.deselectAll')}
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
                  <Typography variant="body1">{t(option.labelKey)}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {t(option.descriptionKey)}
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
          {isLoading ? t('settings.backup.restoring') : t('settings.backup.restore')}
        </Button>
      </Paper>

      {/* Confirmation Dialog */}
      <Dialog
        open={showRestoreConfirm}
        onClose={() => setShowRestoreConfirm(false)}
      >
        <DialogTitle>{t('settings.backup.confirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t('settings.backup.confirmBody')}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowRestoreConfirm(false)}>{t('common.cancel')}</Button>
          <Button onClick={confirmRestore} color="warning" variant="contained">
            {t('settings.backup.restoreAction')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
