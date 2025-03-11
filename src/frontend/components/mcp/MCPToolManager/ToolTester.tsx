'use client';

import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Paper, 
  Typography, 
  TextField, 
  Button, 
  Select, 
  MenuItem, 
  Alert,
  LinearProgress
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import Spinner from '@/frontend/components/shared/Spinner';
import { useServerEvents } from '@/frontend/hooks/useServerEvents';
import { useThemeUtils } from '@/frontend/utils/theme';

const log = createLogger('frontend/components/mcp/MCPToolManager/ToolTester');

interface ToolTestResult {
  success: boolean;
  output: string;
  error?: string;
  progressToken?: string; // Add progress token for tracking
}

interface ToolTesterProps {
  serverName: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, any>;
  }>;
  onTestTool: (toolName: string, params: Record<string, any>, timeout?: number) => Promise<ToolTestResult>;
}

const ToolTester: React.FC<ToolTesterProps> = ({
  serverName,
  tools = [], // Provide default empty array
  onTestTool,
}) => {
  log.debug('Props:', { serverName, toolsCount: tools?.length });
  // Ensure tools is always an array
  const toolsArray = Array.isArray(tools) ? tools : [];
  log.debug('Tools array:', { count: toolsArray.length });
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [params, setParams] = useState<Record<string, any>>({});
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [timeoutValue, setTimeoutValue] = useState<number>(60);
  const [errorNotification, setErrorNotification] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number, total?: number } | null>(null);
  const [activeProgressToken, setActiveProgressToken] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  
  // Subscribe to server events to catch errors and progress updates
  const { lastEvent } = useServerEvents(serverName);
  
  // Handle events from the server (errors and progress updates)
  useEffect(() => {
    if (!lastEvent) return;
    
    // Handle error events
    if (lastEvent.type === 'error') {
      log.warn(`Error event received:`, lastEvent);
      
      let errorMessage = '';
      
      // Format the error message based on the source
      if (lastEvent.source === 'timeout') {
        errorMessage = `Timeout Error: ${lastEvent.message || 'Tool execution timed out'}`;
        // If we're currently loading, stop the loading state
        if (isLoading) {
          setIsLoading(false);
          // Update the result with the timeout error
          setResult({
            success: false,
            output: '',
            error: errorMessage
          });
        }
      } else if (lastEvent.source === 'stderr') {
        errorMessage = `Server Error: ${lastEvent.message || 'Unknown error from server'}`;
      } else {
        errorMessage = `Error: ${lastEvent.message || 'Unknown error occurred'}`;
      }
      
      // Set the error notification
      setErrorNotification(errorMessage);
      
      // Clear the notification after 5 seconds
      const timer = setTimeout(() => {
        setErrorNotification(null);
      }, 5000);
      
      return () => clearTimeout(timer);
    }
    
    // Handle progress events
    if (lastEvent.method === 'notifications/progress' && lastEvent.progressToken === activeProgressToken) {
      log.debug(`Progress event received:`, lastEvent);
      setProgress({
        current: lastEvent.progress,
        total: lastEvent.total
      });
    }
  }, [lastEvent, isLoading, activeProgressToken]);

  const handleToolSelect = (toolName: string) => {
    setSelectedTool(toolName);
    setParams({});
    setResult(null);
  };

  const handleTimeoutChange = (value: string) => {
    const parsedValue = parseInt(value, 10);
    
    if (value === '' || isNaN(parsedValue) || parsedValue < -1) {
      // Empty or invalid or less than -1: use default
      setTimeoutValue(60);
    } else if (parsedValue === 0) {
      // Value of 0: use default
      setTimeoutValue(60);
    } else {
      // Valid value (-1 or positive)
      setTimeoutValue(parsedValue);
    }
  };

  const handleParamChange = (key: string, value: string, schema: any) => {
    let parsedValue: any;

    if (schema.type === 'number') {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue)) {
        // Handle invalid number input, perhaps with a warning message
        log.warn(`Invalid number input for ${key}: ${value}`);
        // Keep the previous value or set to a default number
        return;
      }
    } else if (schema.type === 'boolean') {
      parsedValue = value.toLowerCase() === 'true';
    } else if (schema.type === 'object' || schema.type === 'array') {
      try {
        parsedValue = JSON.parse(value);
      } catch (error) {
        log.warn(`Invalid JSON input for ${key}: ${value}`);
        return;
      }
    } else {
      parsedValue = value;
    }

    setParams((prev) => ({
      ...prev,
      [key]: parsedValue,
    }));
  };

  const handleTest = async () => {
    log.debug(`Testing tool: ${selectedTool} with params:`, params);
    log.debug(`Timeout: ${timeoutValue} seconds`);
    
    // Reset progress and result
    setProgress(null);
    setActiveProgressToken(null);
    setIsLoading(true);
    
    try {
      const result = await onTestTool(selectedTool, params, timeoutValue);
      log.debug(`Test result:`, result);
      
      // Store the progress token if available
      if (result.progressToken) {
        setActiveProgressToken(result.progressToken);
      }
      
      setResult(result);
    } catch (error) {
      log.error(`Error testing tool:`, error);
      setResult({
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
    setIsLoading(false);
  };
  
  // Function to cancel the current tool execution
  const handleCancel = async () => {
    if (isCancelling) return;
    
    // No confirmation dialog - user already decided by clicking the button
    
    setIsCancelling(true);
    log.debug(`Cancelling tool execution`);
    
    try {
      // Call the API to cancel the tool execution
      const url = activeProgressToken 
        ? `/api/mcp/cancel?token=${activeProgressToken}&serverName=${encodeURIComponent(serverName)}`
        : `/api/mcp/cancel?serverName=${encodeURIComponent(serverName)}`;
        
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reason: 'User cancelled operation'
        })
      });
      
      if (response.ok) {
        log.info(`Successfully sent cancellation request`);
        setErrorNotification('Cancellation request sent. The operation should stop shortly.');
      } else {
        const errorData = await response.json();
        log.warn(`Failed to cancel operation:`, errorData);
        setErrorNotification(`Failed to cancel: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      log.error(`Error cancelling tool:`, error);
      setErrorNotification(`Error cancelling: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsCancelling(false);
    }
  };

  const selectedToolData = toolsArray.find((t) => t.name === selectedTool);
  log.debug('Selected tool data:', { name: selectedToolData?.name, hasSchema: !!selectedToolData?.inputSchema });

  const { getThemeValue } = useThemeUtils();
  
  return (
    <Paper
      sx={{
        p: 2,
        bgcolor: (theme) => theme.palette.background.paper,
        color: (theme) => theme.palette.text.primary,
        borderRadius: 2,
        border: 1,
        borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
      }}
    >
      <Typography variant="h6" sx={{ mb: 2, fontWeight: 'semibold' }}>
        Tool Tester - {serverName}
      </Typography>
      
      {/* Error notification */}
      {errorNotification && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {errorNotification}
        </Alert>
      )}
      
      <Box sx={{ mb: 2 }}>
        <Typography 
          component="label" 
          variant="body2" 
          sx={{ 
            display: 'block', 
            mb: 1, 
            fontWeight: 'medium',
            color: (theme) => theme.palette.mode === 'dark' ? '#d1d5db' : '#4b5563'
          }}
        >
          Select Tool
        </Typography>
        <Select
          fullWidth
          value={selectedTool}
          onChange={(e) => handleToolSelect(e.target.value)}
          displayEmpty
          sx={{
            bgcolor: (theme) => theme.palette.background.paper,
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
            }
          }}
        >
          <MenuItem value="">Choose a tool...</MenuItem>
          {toolsArray.map((tool) => (
            <MenuItem key={tool.name} value={tool.name}>
              {tool.name}
            </MenuItem>
          ))}
        </Select>
      </Box>

      {selectedToolData ? (
        <>
          <Box sx={{ mb: 2 }}>
            <Typography 
              variant="body2" 
              sx={{ 
                color: (theme) => theme.palette.mode === 'dark' ? '#9ca3af' : '#6b7280'
              }}
            >
              {selectedToolData.description}
            </Typography>
          </Box>

          <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {Object.entries(selectedToolData.inputSchema.properties || {}).map(
              ([key, schema]: [string, any]) => (
                <Box key={key}>
                  <Typography 
                    component="label" 
                    variant="body2" 
                    sx={{ 
                      display: 'block', 
                      mb: 0.5, 
                      fontWeight: 'medium',
                      color: (theme) => theme.palette.mode === 'dark' ? '#d1d5db' : '#4b5563'
                    }}
                  >
                    {key}
                    {selectedToolData.inputSchema.required?.includes(key) && (
                      <Box component="span" sx={{ color: 'error.main', ml: 0.5 }}>*</Box>
                    )}
                  </Typography>
                  <TextField
                    fullWidth
                    size="small"
                    value={params[key] !== undefined ? String(params[key]) : ''}
                    onChange={(e) => handleParamChange(key, e.target.value, schema)}
                    placeholder={schema.description || ''}
                    sx={{
                      bgcolor: (theme) => theme.palette.background.paper,
                      '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
                      }
                    }}
                  />
                </Box>
              )
            )}
            
            <Box>
              <Typography 
                component="label" 
                variant="body2" 
                sx={{ 
                  display: 'block', 
                  mb: 0.5, 
                  fontWeight: 'medium',
                  color: (theme) => theme.palette.mode === 'dark' ? '#d1d5db' : '#4b5563'
                }}
              >
                Timeout (seconds)
              </Typography>
              <TextField
                type="number"
                fullWidth
                size="small"
                value={timeoutValue === 60 ? '' : timeoutValue}
                onChange={(e) => handleTimeoutChange(e.target.value)}
                placeholder="Default: 60 seconds, -1 for no timeout"
                sx={{
                  bgcolor: (theme) => theme.palette.background.paper,
                  '& .MuiOutlinedInput-notchedOutline': {
                    borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb'
                  }
                }}
              />
              <Typography 
                variant="caption" 
                sx={{ 
                  display: 'block', 
                  mt: 0.5,
                  color: (theme) => theme.palette.mode === 'dark' ? '#9ca3af' : '#6b7280'
                }}
              >
                Default: 60 seconds. Use -1 for no timeout. Value of 0 will be treated as 60.
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleTest}
              disabled={isLoading}
              startIcon={isLoading && <Spinner size="small" color="white" />}
            >
              {isLoading ? 'Testing...' : 'Test Tool'}
            </Button>
            
            {/* Show cancel button whenever a tool is being executed */}
            {isLoading && (
              <Button
                variant="contained"
                color="error"
                onClick={handleCancel}
                disabled={isCancelling}
                startIcon={isCancelling ? 
                  <Spinner size="small" color="white" /> : 
                  <Box component="span" sx={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    width: 16,
                    height: 16
                  }}>
                    <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </Box>
                }
              >
                {isCancelling ? 'Cancelling...' : 'Cancel'}
              </Button>
            )}
          </Box>
          
          {/* Progress indicator */}
          {isLoading && (
            <Box sx={{ mt: 2 }}>
              {!progress && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Spinner size="small" color="primary" />
                  <Typography variant="body2" color="text.secondary">
                    Processing request...
                  </Typography>
                </Box>
              )}
              {progress && (
                <>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">Progress:</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {progress.total 
                        ? `${Math.round(progress.current)}/${Math.round(progress.total)} (${Math.round((progress.current / progress.total) * 100)}%)`
                        : `${Math.round(progress.current)}%`}
                    </Typography>
                  </Box>
                  <LinearProgress 
                    variant="determinate" 
                    value={progress.total 
                      ? Math.min(100, (progress.current / progress.total) * 100)
                      : Math.min(100, progress.current)
                    } 
                  />
                </>
              )}
            </Box>
          )}
        </>
      ) : (
        <Typography color="text.secondary">No tool selected or tool details not found.</Typography>
      )}

      {result && (
        <Paper 
          sx={{ 
            mt: 2, 
            p: 2, 
            bgcolor: (theme) => theme.palette.mode === 'dark' ? '#1a1a1a' : '#f9fafb'
          }}
        >
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 'medium' }}>Result:</Typography>
          {result.success ? (
            <Box 
              component="pre" 
              sx={{ 
                whiteSpace: 'pre-wrap',
                fontSize: '0.875rem',
                p: 1,
                borderRadius: 1,
                border: 1,
                borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb',
                bgcolor: (theme) => theme.palette.background.paper,
                color: (theme) => theme.palette.text.primary,
                overflow: 'auto'
              }}
            >
              {result.output}
            </Box>
          ) : (
            <Typography color="error.main">
              Error: {result.error}
            </Typography>
          )}
        </Paper>
      )}
    </Paper>
  );
};

export default ToolTester;
