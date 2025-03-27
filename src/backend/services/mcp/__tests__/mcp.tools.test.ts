import { listServerTools, callTool, cancelToolExecution } from '../tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { MCPServiceResponse } from '@/shared/types/mcp';

// Mock dependencies
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  })),
}));

jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn().mockImplementation(val => val),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

describe('MCP Tools', () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      listTools: jest.fn().mockResolvedValue({
        tools: [{
          name: 'tool1',
          description: 'Tool 1',
          inputSchema: { type: 'object', properties: {} }
        }]
      }),
      callTool: jest.fn().mockResolvedValue({ result: 'success' }),
      transport: {
        send: jest.fn().mockResolvedValue(undefined)
      },
    };
  });

  describe('listServerTools', () => {
    test('should list available tools', async () => {
      const result = await listServerTools(mockClient, 'test-server');
      
      expect(result.tools).toHaveLength(1);
      expect(result.error).toBeUndefined();
    });

    test('should handle missing client', async () => {
      const result = await listServerTools(undefined, 'test-server');
      
      expect(result.tools).toHaveLength(0);
      expect(result.error).toBe('Server not connected');
    });

    test('should handle errors', async () => {
      mockClient.listTools.mockRejectedValue(new Error('Failed to list tools'));
      
      const result = await listServerTools(mockClient, 'test-server');
      
      expect(result.tools).toHaveLength(0);
      expect(result.error).toContain('Failed to list tools');
    });
  });

  describe('callTool', () => {
    test('should call tool successfully', async () => {
      const mockResponse = { result: 'success' };
      mockClient.callTool.mockResolvedValue(mockResponse);
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', { param: 'value' });
      
      expect(result.success).toBe(true);
      expect(result.data).toBe(mockResponse);
      expect(result.progressToken).toBe('mock-uuid');
    });

    test('should handle tool timeout', async () => {
      mockClient.callTool.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1000)));
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {}, 0.1);
      
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('timeout');
      expect(result.statusCode).toBe(408);
    });

    test('should handle MCP errors', async () => {
      class MockMcpError extends Error {
        constructor(code: number) {
          super('Tool failed');
          this.name = 'McpError';
          this.code = code;
        }
        code: number;
      }

      mockClient.callTool.mockRejectedValue(new MockMcpError(-32000));
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to call tool');
      expect(result.statusCode).toBe(500);
    });

    test('should handle missing client', async () => {
      const result = await callTool(undefined, 'test-server', 'test-tool', {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Server test-server not found');
      expect(result.statusCode).toBe(404);
    });

    test('should work with unlimited timeout (-1)', async () => {
      mockClient.callTool.mockResolvedValue({ result: 'success' });
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {}, -1);
      
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'success' });
      expect(result.progressToken).toBe('mock-uuid');
    });

    test('should work without specifying timeout', async () => {
      mockClient.callTool.mockResolvedValue({ result: 'success' });
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {});
      
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ result: 'success' });
      expect(result.progressToken).toBe('mock-uuid');
    });

    test('should handle non-timeout errors during execution with timeout', async () => {
      // Mock implementation that throws an error that's not a timeout
      mockClient.callTool.mockImplementation(() => {
        throw new Error('Network error');
      });
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {}, 10);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to call tool: Network error');
      expect(result.statusCode).toBe(500);
    });

    test('should handle timeout and successful cancellation', async () => {
      // Instead of using real timers, let's mock the implementation to simulate a timeout
      const originalAbort = global.AbortController.prototype.abort;
      
      // Override the abort method to immediately call the event listeners
      global.AbortController.prototype.abort = function() {
        // Call the original method
        originalAbort.call(this);
        // Manually trigger any abort listeners
        const event = new Event('abort');
        this.signal.dispatchEvent(event);
      };
      
      // When Promise.race is called, we need the second promise to win the race
      const originalPromiseRace = Promise.race;
      Promise.race = jest.fn().mockImplementation((promises) => {
        // Simulate the timeout being triggered
        return Promise.reject(new Error('Tool execution timed out after 1 seconds'));
      });
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {}, 1);
      
      // Restore the original methods
      global.AbortController.prototype.abort = originalAbort;
      Promise.race = originalPromiseRace;
      
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('timeout');
      expect(result.toolName).toBe('test-tool');
      expect(result.timeout).toBe(1);
      expect(mockClient.transport.send).toHaveBeenCalled();
    });

    test('should handle timeout with cancellation error', async () => {
      // Mock the functions just enough to simulate the error path we want to test
      const originalAbort = global.AbortController.prototype.abort;
      
      global.AbortController.prototype.abort = function() {
        originalAbort.call(this);
        const event = new Event('abort');
        this.signal.dispatchEvent(event);
      };
      
      const originalPromiseRace = Promise.race;
      Promise.race = jest.fn().mockImplementation((promises) => {
        return Promise.reject(new Error('Tool execution timed out after 1 seconds'));
      });
      
      // Mock the transport.send to reject
      mockClient.transport.send.mockRejectedValue(new Error('Failed to cancel'));
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {}, 1);
      
      // Restore the original methods
      global.AbortController.prototype.abort = originalAbort;
      Promise.race = originalPromiseRace;
      
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('timeout');
      expect(mockClient.transport.send).toHaveBeenCalled();
    });

    test('should handle generic error', async () => {
      mockClient.callTool.mockRejectedValue('Not an Error instance');
      
      const result = await callTool(mockClient, 'test-server', 'test-tool', {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to call tool: Unknown error');
      expect(result.statusCode).toBe(500);
    });

    test('should handle connection timeout error', async () => {
      mockClient.listTools.mockRejectedValue(new Error('Connection timeout'));
      
      const result = await listServerTools(mockClient, 'test-server');
      
      expect(result.tools).toHaveLength(0);
      expect(result.error).toContain('Connection timeout');
    });
  });

  describe('cancelToolExecution', () => {
    test('should send cancellation notification', async () => {
      await cancelToolExecution(mockClient, 'mock-uuid', 'Test cancellation');
      
      expect(mockClient.transport.send).toHaveBeenCalledWith(
        expect.stringContaining('notifications/cancelled')
      );
    });

    test('should handle missing transport', async () => {
      const clientWithoutTransport = { ...mockClient, transport: undefined };
      
      await expect(
        cancelToolExecution(clientWithoutTransport, 'mock-uuid', 'reason')
      ).rejects.toThrow('Client has no transport');
    });

    test('should handle transport without send method', async () => {
      const clientWithUnsendableTransport = { 
        ...mockClient, 
        transport: { 
          // No send method
        } 
      };
      
      await expect(
        cancelToolExecution(clientWithUnsendableTransport, 'mock-uuid', 'reason')
      ).rejects.toThrow('Transport does not support sending messages');
    });

    test('should handle error in send method', async () => {
      mockClient.transport.send.mockRejectedValue(new Error('Send failed'));
      
      await expect(
        cancelToolExecution(mockClient, 'mock-uuid', 'reason')
      ).rejects.toThrow('Send failed');
    });
  });
}); 