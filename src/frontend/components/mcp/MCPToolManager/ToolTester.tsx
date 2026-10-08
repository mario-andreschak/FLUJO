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
  LinearProgress,
  Switch,
  FormControlLabel,
  IconButton,
  Tooltip
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createLogger } from '@/utils/logger';
import Spinner from '@/frontend/components/shared/Spinner';
import SchemaParamsForm from '@/frontend/components/shared/SchemaParamsForm';
import { useThemeUtils } from '@/frontend/utils/theme';
import { extractUiResourceUri } from '@/shared/utils/mcpApps';
import McpAppFrame from '@/frontend/components/Chat/McpAppFrame'; // #97: render a tool's MCP App here too
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/mcp/MCPToolManager/ToolTester');

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

interface ToolTestResult {
  success: boolean;
  output: string;
  error?: string;
  progressToken?: string; // Add progress token for tracking
}

export interface ToolTesterPrefill {
  toolName: string;
  arguments: Record<string, unknown>;
}

interface ToolTesterProps {
  serverName: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    _meta?: Record<string, unknown>; // #97: carries ui.resourceUri for MCP Apps
  }>;
  onTestTool: (toolName: string, params: Record<string, unknown>, timeout?: number) => Promise<ToolTestResult>;
  onClose?: () => void; // Optional handler to dismiss the tester panel
  prefill?: ToolTesterPrefill;
}

const ToolTester: React.FC<ToolTesterProps> = ({
  serverName,
  tools = [], // Provide default empty array
  onTestTool,
  onClose,
  prefill,
}) => {
  const { t, formatNumber } = useI18n();
  const { settings } = useStorage();
  const autoOpenMcpApps = settings?.experimental?.requireMcpAppLaunchClick !== true;
  log.debug('Props:', { serverName, toolsCount: tools?.length });
  // Ensure tools is always an array
  const toolsArray = Array.isArray(tools) ? tools : [];
  log.debug('Tools array:', { count: toolsArray.length });
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [timeoutValue, setTimeoutValue] = useState<number>(60);
  const [errorNotification, setErrorNotification] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number, total?: number } | null>(null);
  const [activeProgressToken, setActiveProgressToken] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showRawResult, setShowRawResult] = useState(false); // State for toggling raw/rendered view

  useEffect(() => {
    if (!prefill || !toolsArray.some((tool) => tool.name === prefill.toolName)) return;
    setSelectedTool(prefill.toolName);
    setParams({ ...prefill.arguments });
    setResult(null);
    setProgress(null);
    setActiveProgressToken(null);
    setErrorNotification(null);
  }, [prefill, tools]);

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

  const handleTest = async () => {
    log.debug(`Testing tool: ${selectedTool} with params:`, JSON.stringify(params));
    log.debug(`Timeout: ${timeoutValue} seconds`);
    
    // Reset progress and result
    setProgress(null);
    setActiveProgressToken(null);
    setIsLoading(true);
    
    try {
      // Ensure parameters are correctly typed according to the schema before sending
      const typedParams: Record<string, unknown> = {};
      const selectedToolData = toolsArray.find((t) => t.name === selectedTool);
      
      if (selectedToolData?.inputSchema?.properties) {
        const schemaProperties = asRecord(selectedToolData.inputSchema.properties) ?? {};
        // Process each parameter according to its schema type
        Object.entries(params).forEach(([key, value]) => {
          const schema = asRecord(schemaProperties[key]);
          if (!schema) {
            typedParams[key] = value;
            return;
          }
          
          if (schema.type === 'number' || schema.type === 'integer') {
            // Ensure number parameters are actually numbers, not strings
            const numValue = typeof value === 'string' ? parseFloat(value) : value;
            typedParams[key] = isNaN(numValue as number) ? 0 : numValue;
          } else if (schema.type === 'boolean') {
            // Ensure boolean parameters are actually booleans
            typedParams[key] = Boolean(value);
          } else {
            typedParams[key] = value;
          }
        });
      } else {
        // If no schema is available, use params as is
        Object.assign(typedParams, params);
      }
      
      log.debug(`Sending typed params:`, JSON.stringify(typedParams));
      const result = await onTestTool(selectedTool, typedParams, timeoutValue);
      log.debug(`Test result:`, JSON.stringify(result));
      
      // Store the progress token if available
      if (result && result.progressToken) {
        setActiveProgressToken(result.progressToken);
      }
      
      setResult(result);
    } catch (error) {
      log.error(`Error testing tool:`, error);
      setResult({
        success: false,
        output: '',
        error: error instanceof Error ? error.message : t('mcp.tester.unknownError'),
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
          reason: t('mcp.tester.cancel')
        })
      });
      
      if (response.ok) {
        log.info(`Successfully sent cancellation request`);
        setErrorNotification(t('mcp.tester.cancelSent'));
      } else {
        const errorData = await response.json();
        log.warn(`Failed to cancel operation:`, errorData);
        setErrorNotification(t('mcp.tester.cancelFailed', {
          error: errorData.error || t('mcp.tester.unknownError'),
        }));
      }
    } catch (error) {
      log.error(`Error cancelling tool:`, error);
      setErrorNotification(t('mcp.tester.cancelError', {
        error: error instanceof Error ? error.message : t('mcp.tester.unknownError'),
      }));
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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6" sx={{ fontWeight: 'semibold' }}>
          {t('mcp.tester.title', { server: serverName })}
        </Typography>
        {onClose && (
          <Tooltip title={t('mcp.tester.close')}>
            <IconButton size="small" onClick={onClose} aria-label={t('mcp.tester.close')}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

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
          {t('mcp.tester.select')}
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
          <MenuItem value="">{t('mcp.tester.choose')}</MenuItem>
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
            <SchemaParamsForm
              schema={selectedToolData.inputSchema}
              values={params}
              onChange={setParams}
            />

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
                {t('mcp.tester.timeout')}
              </Typography>
              <TextField
                type="number"
                fullWidth
                size="small"
                value={timeoutValue === 60 ? '' : timeoutValue}
                onChange={(e) => handleTimeoutChange(e.target.value)}
                placeholder={t('mcp.tester.timeoutPlaceholder')}
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
                {t('mcp.tester.timeoutHelp')}
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
              {isLoading ? t('mcp.tester.testing') : t('mcp.tester.test')}
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
                {isCancelling ? t('mcp.tester.cancelling') : t('mcp.tester.cancel')}
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
                    {t('mcp.tester.processing')}
                  </Typography>
                </Box>
              )}
              {progress && (
                <>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography variant="body2" color="text.secondary">{t('mcp.tester.progress')}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {progress.total 
                        ? `${formatNumber(Math.round(progress.current))}/${formatNumber(Math.round(progress.total))} (${formatNumber(progress.current / progress.total, { style: 'percent', maximumFractionDigits: 0 })})`
                        : formatNumber(progress.current / 100, { style: 'percent', maximumFractionDigits: 0 })}
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
        <Typography color="text.secondary">{t('mcp.tester.noSelection')}</Typography>
      )}

      {/* Interactive output is the primary result for an MCP App tool. Put it
          before the raw/text payload and reveal it immediately once the server
          has already been granted MCP Apps access. */}
      {result?.success && (() => {
        const uiUri = extractUiResourceUri(selectedToolData?._meta);
        if (!uiUri) return null;
        let resultContent: string | undefined;
        try {
          const parsed = JSON.parse(result.output);
          resultContent = JSON.stringify(parsed?.data ?? parsed);
        } catch {
          resultContent = undefined;
        }
        return (
          <McpAppFrame
            defaultExpanded={autoOpenMcpApps}
            serverName={serverName}
            uri={uiUri}
            toolName={selectedTool}
            toolArgs={JSON.stringify(params)}
            toolResultContent={resultContent}
          />
        );
      })()}

      {result && (
        <Paper
          sx={{
            mt: 2,
            p: 2,
            bgcolor: (theme) => theme.palette.mode === 'dark' ? '#1a1a1a' : '#f9fafb'
          }}
        >
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'medium' }}>{t('mcp.tester.result')}</Typography>
            <FormControlLabel
              control={<Switch checked={showRawResult} onChange={(e) => setShowRawResult(e.target.checked)} size="small" />}
              label={t('mcp.tester.showRaw')}
              sx={{ mr: 0 }}
            />
          </Box>

          {showRawResult ? (
            // Show raw output
            <Box
              component="pre"
              sx={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                fontSize: '0.875rem',
                p: 1,
                borderRadius: 1,
                border: 1,
                borderColor: (theme) => theme.palette.mode === 'dark' ? '#3a3a3a' : '#e5e7eb',
                bgcolor: (theme) => theme.palette.background.paper,
                color: (theme) => theme.palette.text.primary,
                overflow: 'auto',
                maxHeight: '400px', // Limit height for raw view
              }}
            >
              {result.success ? result.output : t('mcp.tester.error', { error: result.error ?? '' })}
            </Box>
          ) : (
            // Show rendered output or error
            result.success ? (
              (() => {
                try {
                  const parsedOutput: unknown = JSON.parse(result.output);
                  const parsedRecord = asRecord(parsedOutput);
                  const parsedData = asRecord(parsedRecord?.data);
                  // Check if it has the expected MCP content structure (nested under 'data')
                  if (Array.isArray(parsedData?.content)) {
                    return (
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {parsedData.content.map((item, index) => {
                          const itemRecord = asRecord(item);
                          const itemType = typeof itemRecord?.type === 'string' ? itemRecord.type : 'unknown';
                          const itemText = typeof itemRecord?.text === 'string' ? itemRecord.text : undefined;
                          const itemData = typeof itemRecord?.data === 'string' ? itemRecord.data : undefined;
                          const itemMimeType = typeof itemRecord?.mimeType === 'string' ? itemRecord.mimeType : undefined;
                          if (itemType === 'text' && itemText !== undefined) {
                            return <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>{itemText}</ReactMarkdown>;
                          } else if (itemType === 'image' && itemData && itemMimeType) {
                            return (
                              // MCP tool images are data URLs, which the Next image optimizer does not support.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                key={index}
                                src={`data:${itemMimeType};base64,${itemData}`}
                                alt={t('mcp.tester.imageAlt', { number: formatNumber(index + 1) })}
                                style={{ maxWidth: '100%', height: 'auto', borderRadius: '4px' }}
                              />
                            );
                          } else if (itemType === 'audio' && itemData && itemMimeType) {
                            return (
                              <audio
                                key={index}
                                controls
                                src={`data:${itemMimeType};base64,${itemData}`}
                                style={{ width: '100%' }}
                              >
                                {t('mcp.tester.audioUnsupported')}
                              </audio>
                            );
                          } else {
                            // Fallback for unknown content types or structure
                            return (
                              <Box
                                key={index}
                                component="pre"
                                sx={{
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-all',
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
                                {JSON.stringify(item, null, 2)}
                              </Box>
                            );
                          }
                        })}
                      </Box>
                    );
                  } else {
                    // If JSON doesn't match expected structure (e.g., missing data or content array), show raw JSON
                    throw new Error("Output is valid JSON but not in the expected MCP 'data.content' format.");
                  }
                } catch (e) {
                  // If output is not valid JSON or doesn't match structure, display as plain text
                  return (
                    <Box
                      component="pre"
                      sx={{
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all', // Ensure long strings wrap
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
                  );
                }
              })()
            ) : (
              <Typography color="error.main">
                {t('mcp.tester.error', { error: result.error ?? '' })}
              </Typography>
            )
          )}
        </Paper>
      )}

    </Paper>
  );
};

export default ToolTester;
