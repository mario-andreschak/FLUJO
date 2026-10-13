import { JsonRpcResponseError } from '@modelcontextprotocol/ext-tasks/client';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

/** Wire errors retain their numeric code/data across both supported SDK generations. */
export function mcpProtocolError(error: unknown): { code: number; data?: unknown } | undefined {
  return error instanceof McpError || error instanceof ProtocolError || error instanceof JsonRpcResponseError
    ? { code: error.code, ...(error.data === undefined ? {} : { data: error.data }) } : undefined;
}

export function isMcpRequestTimeout(error: unknown): boolean {
  return (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
    || (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout);
}

export function mcpErrorStatus(code: number): number {
  return code === -32601 ? 404 : code === -32602 || code === -32600 ? 400 : 500;
}
