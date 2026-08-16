"use client";

import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Divider,
  Paper,
} from '@mui/material';
import { FlowNode } from '@/frontend/types/flow/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

interface FinishNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
}

export const FinishNodePropertiesModal = ({ open, node, onClose, onSave }: FinishNodePropertiesModalProps) => {
  const { t } = useI18n();
  // Clone node data to avoid direct mutation
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { ...node.data.properties }
      });
    }
  }, [node, open]);

  const handleSave = () => {
    if (node && nodeData) {
      onSave(node.id, nodeData);
      onClose();
    }
  };

  if (!node || !nodeData) return null;

  return (
    <Dialog 
      open={open} 
      onClose={onClose}
      maxWidth="md" 
      fullWidth
      PaperProps={{
        sx: {
          borderTop: 5, 
          borderColor: 'success.main',
          width: '600px',
          height: '400px',
          maxWidth: '95vw',
          maxHeight: '90vh',
        }
      }}
    >
      <DialogHeaderActions
        title={t('flows.modal.properties', { name: nodeData.label || t('flows.modal.finishNode') })}
        onClose={onClose}
      />
      
      <Divider />
      
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', p: 3, overflow: 'auto' }}>
        <Box 
          sx={{ 
            display: 'flex', 
            flexDirection: 'column', 
            height: '100%',
            justifyContent: 'center',
            alignItems: 'center',
            py: 4
          }}
        >
          <Paper 
            elevation={0} 
            sx={{ 
              p: 4, 
              textAlign: 'center',
              backgroundColor: 'rgba(76, 175, 80, 0.08)',
              borderRadius: 2,
              width: '100%'
            }}
          >
            <Typography variant="h6" color="success.main" gutterBottom>
              {t('flows.modal.finishNode')}
            </Typography>
            <Typography variant="body1" color="text.secondary">
              {t('flows.modal.finishHelp')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2, fontStyle: 'italic' }}>
              {t('flows.modal.finishFuture')}
            </Typography>
          </Paper>
        </Box>
      </DialogContent>
      
      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained" color="primary">
          {t('flows.modal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default FinishNodePropertiesModal;
