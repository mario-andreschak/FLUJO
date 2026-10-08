'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  mcpService,
  type StreamingToolProgress as ToolCallProgress,
  type StreamingToolResult as ToolCallResult,
} from '@/frontend/services/mcp';

export type {
  StreamingToolProgress as ToolCallProgress,
  StreamingToolResult as ToolCallResult,
} from '@/frontend/services/mcp';

export interface UseToolCallState {
  isLoading: boolean;
  progress: ToolCallProgress | null;
  result: ToolCallResult | null;
  error: string | null;
}

export interface UseToolCallReturn extends UseToolCallState {
  call: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
    ownerScope?: string,
  ) => Promise<ToolCallResult>;
  abort: () => void;
  reset: () => void;
}

/**
 * Stream an MCP call without tying transport work to React rendering.
 * A generation guard prevents a cancelled request's late callback from
 * overwriting a newer invocation.
 */
function useStreamingToolCall(source: 'host' | 'app'): UseToolCallReturn {
  const [state, setState] = useState<UseToolCallState>({
    isLoading: false,
    progress: null,
    result: null,
    error: null,
  });
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const reset = useCallback(() => {
    generationRef.current++;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState({
      isLoading: false,
      progress: null,
      result: null,
      error: null,
    });
  }, []);

  const abort = useCallback(() => {
    generationRef.current++;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setState(prev => ({
      ...prev,
      isLoading: false,
      result: { success: false, error: 'Aborted by user', errorType: 'cancelled' },
      error: 'Aborted by user',
    }));
  }, []);

  const call = useCallback(async (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeout?: number,
    ownerScope?: string,
  ): Promise<ToolCallResult> => {
    abortControllerRef.current?.abort();
    const generation = ++generationRef.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setState({ isLoading: true, progress: null, result: null, error: null });

    try {
      const result = await mcpService.callToolStream(serverName, toolName, args, {
        timeout,
        signal: abortController.signal,
        source,
        ownerScope,
        onProgress: (progress) => {
          if (generation !== generationRef.current) return;
          setState(prev => ({ ...prev, progress }));
        },
      });
      if (generation === generationRef.current) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          result,
          error: result.success ? null : result.error ?? 'Tool call failed',
        }));
      }
      return result;
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const errorMessage = cancelled
        ? 'Aborted by user'
        : error instanceof Error ? error.message : 'Unknown error';
      const errorResult: ToolCallResult = {
        success: false,
        error: errorMessage,
        errorType: cancelled ? 'cancelled' : undefined,
      };
      if (generation === generationRef.current) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          result: errorResult,
          error: errorMessage,
        }));
      }
      return errorResult;
    } finally {
      if (generation === generationRef.current) abortControllerRef.current = null;
    }
  }, [source]);

  useEffect(() => () => {
    generationRef.current++;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  return { ...state, call, abort, reset };
}

export function useToolCall(): UseToolCallReturn {
  return useStreamingToolCall('host');
}

export function useToolCallFromApp(): UseToolCallReturn {
  return useStreamingToolCall('app');
}
