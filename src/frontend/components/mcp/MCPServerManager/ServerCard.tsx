'use client';

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerCard');
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ErrorIcon from '@mui/icons-material/Error';
import RefreshIcon from '@mui/icons-material/Refresh';
import Spinner from '@/frontend/components/shared/Spinner';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

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
}) => {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  
  const statusColor = {
    connected: 'text-green-500',
    disconnected: 'text-gray-500',
    error: 'text-red-500',
    connecting: 'text-blue-500',
    initialization: 'text-blue-500', // Same color as connecting
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
  
  // Stop propagation for buttons to prevent card click
  const handleButtonClick = (e: React.MouseEvent, callback: () => void, action: string) => {
    log.debug(`${action} button clicked for server: ${name}`);
    e.stopPropagation();
    callback();
  };
  
  // Reference to store the timeout ID - using any to accommodate different TS environments
  const [retryTimeoutId, setRetryTimeoutId] = useState<any>(null);
  
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
    
    // Store the timeout ID - cast to any to avoid type issues
    setRetryTimeoutId(timeoutId as any);
  };

  return (
    <div 
      className="border rounded-lg p-4 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => {
        log.debug(`Server card clicked: ${name}`);
        onClick();
      }}
    >
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-lg font-semibold">{name}</h3>
        <div className="flex items-center">
          {status === 'connected' && <CheckCircleIcon className="text-green-500 mr-1" fontSize="small" />}
          {status === 'disconnected' && <CancelIcon className="text-gray-500 mr-1" fontSize="small" />}
          {status === 'error' && <ErrorIcon className="text-red-500 mr-1" fontSize="small" />}
          {(status === 'connecting' || status === 'initialization') && <Spinner size="small" color="primary" className="mr-1" />}
          <span className={`${statusColor} text-sm`}>{status}</span>
        </div>
      </div>
      
      <p className="text-sm text-gray-600 mb-2 truncate" title={path}>
        {path}
      </p>

      {status === 'error' && (
        <div className="text-sm text-red-600 mb-2">
          <div className="flex justify-between items-center">
            <p className="font-semibold">Error:</p>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                log.debug(`View full error clicked for server: ${name}`);
                setShowErrorModal(true);
              }}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              View Full Error
            </button>
          </div>
          <div className="max-h-24 overflow-y-auto bg-red-50 p-2 rounded border border-red-200 whitespace-pre-wrap">
            {error || 'Unknown error'}
          </div>
        </div>
      )}
      
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
        <DialogTitle>
          Error Details for {name}
        </DialogTitle>
        <DialogContent>
          <div className="bg-red-50 p-4 rounded border border-red-200 whitespace-pre-wrap font-mono text-sm overflow-auto max-h-96">
            {error || 'Unknown error'}
          </div>
          
          {stderrOutput && (
            <div className="mt-4">
              <h3 className="text-lg font-semibold mb-2">Stderr Output:</h3>
              <div className="bg-gray-100 p-4 rounded border border-gray-300 whitespace-pre-wrap font-mono text-sm overflow-auto max-h-96">
                {stderrOutput}
              </div>
            </div>
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
      
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <label className="relative inline-flex items-center cursor-pointer" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="sr-only peer"
              checked={enabled}
              onChange={(e) => {
                log.debug(`Server ${name} toggle changed to: ${e.target.checked}`);
                onToggle(e.target.checked);
              }}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
            <span className="ml-2 text-sm font-medium text-gray-900 dark:text-gray-300">
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
          
          {/* Add restart button */}
          {enabled && (
            <button
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
              className="ml-2 p-1 text-gray-500 hover:text-gray-700"
              title="Restart server"
            >
              <RefreshIcon fontSize="small" />
            </button>
          )}
        </div>
        
        <div className="flex space-x-2">
          <button
            onClick={handleRetryClick}
            className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800 flex items-center"
          >
            {isPolling ? <Spinner size="small" color="primary" className="mr-1" /> : null}
            Retry
          </button>
          <button
            onClick={(e) => handleButtonClick(e, onEdit, 'Edit')}
            className="px-3 py-1 text-sm text-gray-600 hover:text-gray-800"
          >
            Edit
          </button>
          <button
            onClick={(e) => handleButtonClick(e, onDelete, 'Delete')}
            className="px-3 py-1 text-sm text-red-600 hover:text-red-800"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export default ServerCard;
