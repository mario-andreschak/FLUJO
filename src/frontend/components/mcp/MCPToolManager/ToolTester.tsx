'use client';

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';
import Spinner from '@/frontend/components/shared/Spinner';
import { useServerEvents } from '@/frontend/hooks/useServerEvents';

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

  return (
    <div className="border rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">Tool Tester - {serverName}</h3>
      
      {/* Error notification */}
      {errorNotification && (
        <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded-md">
          <p>{errorNotification}</p>
        </div>
      )}
      
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Tool
        </label>
        <select
          className="w-full p-2 border rounded-md"
          value={selectedTool}
          onChange={(e) => handleToolSelect(e.target.value)}
        >
          <option value="">Choose a tool...</option>
          {toolsArray.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
      </div>

      {selectedToolData ? (
        <>
          <div className="mb-4">
            <p className="text-sm text-gray-600">{selectedToolData.description}</p>
          </div>

          <div className="space-y-4 mb-4">
            {Object.entries(selectedToolData.inputSchema.properties || {}).map(
              ([key, schema]: [string, any]) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {key}
                    {selectedToolData.inputSchema.required?.includes(key) && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </label>
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md"
                    value={params[key] !== undefined ? String(params[key]) : ''}
                    onChange={(e) => handleParamChange(key, e.target.value, schema)}
                    placeholder={schema.description || ''}
                  />
                </div>
              )
            )}
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Timeout (seconds)
              </label>
              <input
                type="number"
                className="w-full p-2 border rounded-md"
                value={timeoutValue === 60 ? '' : timeoutValue}
                onChange={(e) => handleTimeoutChange(e.target.value)}
                placeholder="Default: 60 seconds, -1 for no timeout"
              />
              <p className="text-xs text-gray-500 mt-1">
                Default: 60 seconds. Use -1 for no timeout. Value of 0 will be treated as 60.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              className="bg-blue-500 text-white px-4 py-2 rounded-md hover:bg-blue-600 disabled:opacity-50"
              onClick={handleTest}
              disabled={isLoading}
            >
              {isLoading ? (
                <span className="flex items-center">
                  <Spinner size="small" color="white" className="mr-2" />
                  Testing...
                </span>
              ) : 'Test Tool'}
            </button>
            
            {/* Show cancel button whenever a tool is being executed */}
            {isLoading && (
              <button
                className="bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600 disabled:opacity-50 flex items-center"
                onClick={handleCancel}
                disabled={isCancelling}
              >
                {isCancelling ? (
                  <>
                    <Spinner size="small" color="white" className="mr-2" />
                    Cancelling...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                    Cancel
                  </>
                )}
              </button>
            )}
          </div>
          
          {/* Progress indicator */}
          {isLoading && (
            <div className="mt-4">
              {!progress && (
                <div className="flex items-center space-x-2 mb-2">
                  <Spinner size="small" color="primary" />
                  <span className="text-sm text-gray-600">Processing request...</span>
                </div>
              )}
              {progress && (
                <>
                  <div className="flex justify-between text-sm text-gray-600 mb-1">
                    <span>Progress:</span>
                    <span>
                      {progress.total 
                        ? `${Math.round(progress.current)}/${Math.round(progress.total)} (${Math.round((progress.current / progress.total) * 100)}%)`
                        : `${Math.round(progress.current)}%`}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div 
                      className="bg-blue-600 h-2.5 rounded-full" 
                      style={{ 
                        width: progress.total 
                          ? `${Math.min(100, (progress.current / progress.total) * 100)}%`
                          : `${Math.min(100, progress.current)}%`
                      }}
                    ></div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-gray-500">No tool selected or tool details not found.</div>
      )}

      {result && (
        <div className="mt-4 p-4 rounded-md bg-gray-50">
          <h4 className="font-medium mb-2">Result:</h4>
          {result.success ? (
            <pre className="whitespace-pre-wrap text-sm bg-white p-2 rounded border">
              {result.output}
            </pre>
          ) : (
            <div className="text-red-500">
              <p>Error: {result.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolTester;
