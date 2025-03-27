import { NextRequest } from 'next/server';
import { GET, POST } from '../handlers';
import { mcpService } from '@/backend/services/mcp';
import { jest } from '@jest/globals';
import { MCPServerConfig, MCPStdioConfig, MCPServiceResponse } from '@/shared/types/mcp';
import { loadItem, saveItem } from '@/utils/storage/backend';

// Mock the storage utilities
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn().mockImplementation(async () => {})
}));

// Mock the MCP service
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(),
    listServerTools: jest.fn(),
    getServerStatus: jest.fn(),
    updateServerConfig: jest.fn(),
    deleteServerConfig: jest.fn(),
    disconnectServer: jest.fn(),
    callTool: jest.fn()
  }
}));

const mockMcpService = mcpService as jest.Mocked<typeof mcpService>;
const mockLoadItem = loadItem as jest.MockedFunction<typeof loadItem>;
const mockSaveItem = saveItem as jest.MockedFunction<typeof saveItem>;

describe('MCP API Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Setup default mock responses
    mockLoadItem.mockResolvedValue({});
    mockSaveItem.mockImplementation(async () => {});
  });

  describe('GET /api/mcp', () => {
    it('should handle loadConfigs action', async () => {
      const configs: MCPStdioConfig[] = [
        {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          disabled: false,
          autoApprove: [],
          rootPath: '',
          env: {},
          _buildCommand: '',
          _installCommand: '',
          stderr: 'inherit'
        }
      ];
      mockMcpService.loadServerConfigs.mockResolvedValue(configs);

      const request = new NextRequest(new URL('http://localhost/api/mcp?action=loadConfigs'));
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.configs).toEqual(configs);
    });

    it('should handle listTools action', async () => {
      const tools = {
        tools: [
          {
            name: 'tool1',
            description: 'Test tool 1',
            inputSchema: { type: 'object' as const, properties: {} }
          },
          {
            name: 'tool2',
            description: 'Test tool 2',
            inputSchema: { type: 'object' as const, properties: {} }
          }
        ]
      };
      mockMcpService.listServerTools.mockResolvedValue(tools);

      const request = new NextRequest(new URL('http://localhost/api/mcp?action=listTools&server=test-server'));
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.tools).toEqual(tools.tools);
    });

    it('should handle status action', async () => {
      const status = { status: 'online' };
      mockMcpService.getServerStatus.mockResolvedValue(status);

      const request = new NextRequest(new URL('http://localhost/api/mcp?action=status&server=test-server'));
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.status).toBe('online');
    });
  });

  describe('POST /api/mcp', () => {
    it('should handle updateConfig action', async () => {
      const config: MCPStdioConfig = {
        name: 'test-server',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        disabled: false,
        autoApprove: [],
        rootPath: '',
        env: {},
        _buildCommand: '',
        _installCommand: '',
        stderr: 'inherit'
      };
      mockMcpService.updateServerConfig.mockResolvedValue(config);

      const request = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          action: 'updateConfig',
          serverName: 'test-server',
          ...config
        })
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual(config);
      expect(mockMcpService.updateServerConfig).toHaveBeenCalledWith('test-server', config);
    });

    it('should handle updateConfig action failure', async () => {
      const error = { success: false, error: 'Failed to update config' };
      mockMcpService.updateServerConfig.mockResolvedValue(error);

      const request = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          action: 'updateConfig',
          serverName: 'test-server',
          transport: 'stdio',
          command: 'invalid'
        })
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Failed to update config');
    });

    it('should handle deleteConfig action', async () => {
      const result: MCPServiceResponse = { success: true };
      mockMcpService.deleteServerConfig.mockResolvedValue(result);

      const request = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          action: 'deleteConfig',
          serverName: 'test-server'
        })
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should handle disconnect action', async () => {
      const result: MCPServiceResponse = { success: true };
      mockMcpService.disconnectServer.mockResolvedValue(result);

      const request = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          action: 'disconnect',
          serverName: 'test-server'
        })
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should handle callTool action', async () => {
      const toolResult: MCPServiceResponse = { success: true, data: 'tool output' };
      mockMcpService.callTool.mockResolvedValue(toolResult);

      const request = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: JSON.stringify({
          action: 'callTool',
          serverName: 'test-server',
          toolName: 'test-tool',
          args: { param: 'value' }
        })
      });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toBe('tool output');
    });
  });
}); 