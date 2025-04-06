'use client';

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';
import { useThemeUtils } from '@/frontend/utils/theme';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerCard');
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ErrorIcon from '@mui/icons-material/Error';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import Spinner from '@/frontend/components/shared/Spinner';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { 
  Switch, 
  Typography, 
  IconButton, 
  Tooltip, 
  useTheme, 
  Card, 
  CardContent, 
  CardActions,
  Box
} from '@mui/material';

interface ServerCardProps {
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'initialization';
  path: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onRetry: () => void;
  onDelete: () => void;
  onClick: () => void;
  onEdit: () => void;
  error?: string; // Optional error message
  stderrOutput?: string; // Optional stderr output
  containerName?: string; // Optional Docker container name
}

const ServerCard: React.FC<ServerCardProps> = ({
  name,
  status,
  path,
  enabled,
  onToggle,
  onRetry,
  onDelete,
  onClick,
  onEdit,
  error,
  stderrOutput,
  containerName,
}) => {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const muiTheme = useTheme();
  
  const statusColor = {
    connected: 'success.main',
    disconnected: 'text.secondary',
    error: 'error.main',
    connecting: 'info.main',
    initialization: 'info.main', // Same color as connecting
  }[status];
  
  // Poll for status updates when server is connecting or initializing
  useEffect(() => {
    if ((status === 'connecting' || status === 'initialization') && enabled) {
      setIsPolling(true);
      const timer = setTimeout(() => {
        log.debug(`Polling status for server: ${name}`);
        onRetry();
      }, 2000);
      
      return () => {
        clearTimeout(timer);
        setIsPolling(false);
      };
    } else if (status !== 'connecting' && status !== 'initialization') {
      setIsPolling(false);
    }
  }, [status, enabled, name, onRetry]);
  
  // Reference to store the timeout ID
  const [retryTimeoutId, setRetryTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);
  
  // Clear the timeout when component unmounts or when status changes
  useEffect(() => {
    return () => {
      if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [retryTimeoutId]);
  
  // Handle retry button click
  const handleRetryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug(`Retry button clicked for server: ${name}`);
    
    // Clear any existing timeout
    if (retryTimeoutId) {
      clearTimeout(retryTimeoutId);
    }
    
    // Set polling immediately to show spinner right away
    setIsPolling(true);
    
    // Then call the retry function
    onRetry();
    
    // If status doesn't change to 'connecting' or 'initialization' within 10 seconds, stop showing spinner
    const timeoutId = setTimeout(() => {
      if (status !== 'connecting' && status !== 'initialization') {
        setIsPolling(false);
      }
      setRetryTimeoutId(null);
    }, 10000);
    
    // Store the timeout ID
    setRetryTimeoutId(timeoutId);
  };

  const { getThemeValue, getThemeColor, colors } = useThemeUtils();
  
  return (
    <Card 
      sx={{ 
        cursor: 'pointer',
        transition: 'box-shadow 0.3s ease',
        '&:hover': {
          boxShadow: 3
        }
      }}
      onClick={() => {
        log.debug(`Server card clicked: ${name}`);
        onClick();
      }}
    >
      <CardContent sx={{ pb: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h6" component="h3">
            {name}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {status === 'connected' && <CheckCircleIcon color="success" sx={{ mr: 0.5 }} fontSize="small" />}
            {status === 'disconnected' && <CancelIcon color="action" sx={{ mr: 0.5 }} fontSize="small" />}
            {status === 'error' && <ErrorIcon color="error" sx={{ mr: 0.5 }} fontSize="small" />}
            {(status === 'connecting' || status === 'initialization') && <Spinner size="small" color="primary" sx={{ mr: 0.5 }} />}
            <Typography variant="body2" color={statusColor}>
              {status}
            </Typography>
          </Box>
        </Box>
        
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: '0.875rem' }} noWrap title={path}>
          {path}
        </Typography>
        
        {containerName && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: '0.875rem' }}>
            <span style={{ fontWeight: 'medium' }}>Docker container:</span> {containerName}
          </Typography>
        )}

        {status === 'error' && (
          <Box sx={{ mt: 1, mb: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <Typography variant="body2" fontWeight="medium" color="error">
                Error:
              </Typography>
              <Button 
                size="small"
                color="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  log.debug(`View full error clicked for server: ${name}`);
                  setShowErrorModal(true);
                }}
              >
                View Full Error
              </Button>
            </Box>
            <Box sx={{ 
              maxHeight: '80px', 
              overflow: 'auto', 
              p: 1, 
              borderRadius: 1, 
              bgcolor: (theme) => getThemeColor('error.background'),
              color: (theme) => getThemeColor('error.text'),
              border: '1px solid',
              borderColor: (theme) => getThemeColor('error.border'),
              fontSize: '0.75rem',
              fontWeight: 500,
              whiteSpace: 'pre-wrap'
            }}>
              {error || 'Unknown error'}
            </Box>
          </Box>
        )}
      </CardContent>
      
      <CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Switch
            checked={enabled}
            onChange={(e) => {
              e.stopPropagation();
              log.debug(`Server ${name} toggle changed to: ${e.target.checked}`);
              onToggle(e.target.checked);
            }}
            color="primary"
            size="small"
          />
          <Typography 
            variant="body2" 
            sx={{ 
              ml: 0.5, 
              fontWeight: 500,
              color: enabled ? 'primary.main' : 'text.secondary'
            }}
          >
            {enabled ? 'Enabled' : 'Disabled'}
          </Typography>
          
          {enabled && (
            <Tooltip title="Restart server">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  log.debug(`Restart button clicked for server: ${name}`);
                  
                  // Disable the server
                  onToggle(false);
                  
                  // Wait a short time for the disconnect to complete
                  setTimeout(() => {
                    // Enable the server
                    onToggle(true);
                    log.info(`Server ${name} restarted`);
                  }, 1000);
                }}
                sx={{ ml: 1 }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        
        <Box>
          <Tooltip title="Retry connection">
            <IconButton 
              color="primary" 
              onClick={handleRetryClick}
              disabled={isPolling}
              size="small"
            >
              {isPolling ? <Spinner size="small" color="primary" /> : <RefreshIcon />}
            </IconButton>
          </Tooltip>
          
          <Tooltip title="Edit server">
            <IconButton 
              color="primary" 
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              size="small"
            >
              <EditIcon />
            </IconButton>
          </Tooltip>
          
          <Tooltip title="Delete server">
            <IconButton 
              color="error" 
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              size="small"
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
      
      {/* Error Modal */}
      <Dialog 
        open={showErrorModal} 
        onClose={() => {
          log.debug(`Error modal closed for server: ${name}`);
          setShowErrorModal(false);
        }}
        maxWidth="md"
        fullWidth
        onClick={(e) => e.stopPropagation()}
      >
        <DialogTitle component="div">
          Error Details for {name}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ 
            p: 2, 
            borderRadius: 1, 
            bgcolor: (theme) => getThemeColor('error.background'),
            color: (theme) => getThemeColor('error.text'),
            border: '1px solid',
            borderColor: (theme) => getThemeColor('error.border'),
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            fontWeight: 500,
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            maxHeight: '300px',
            mb: 2
          }}>
            {error || 'Unknown error'}
          </Box>
          
          {stderrOutput && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="h6" gutterBottom>
                Stderr Output:
              </Typography>
              <Box sx={{ 
                p: 2, 
                borderRadius: 1, 
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                whiteSpace: 'pre-wrap',
                overflow: 'auto',
                maxHeight: '300px'
              }}>
                {stderrOutput}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowErrorModal(false)}>Close</Button>
          <Button 
            onClick={() => {
              const textToCopy = [
                error || 'Unknown error',
                stderrOutput ? `\n\nStderr Output:\n${stderrOutput}` : ''
              ].join('');
              navigator.clipboard.writeText(textToCopy);
              log.debug(`Error copied to clipboard for server: ${name}`);
              setShowToast(true);
            }}
            color="primary"
          >
            Copy to Clipboard
          </Button>
        </DialogActions>
      </Dialog>
      
      {/* Toast notification */}
      <Snackbar
        open={showToast}
        autoHideDuration={3000}
        onClose={() => setShowToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setShowToast(false)} severity="success" sx={{ width: '100%' }}>
          Error message copied to clipboard
        </Alert>
      </Snackbar>
    </Card>
  );
};

export default ServerCard;
