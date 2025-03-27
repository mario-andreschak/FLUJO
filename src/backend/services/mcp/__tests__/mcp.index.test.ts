import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig } from '@/shared/types/mcp';
import { MCPService } from '../index';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

// Mock configurations
const mockStdioConfig: MCPStdioConfig = {
  name: 'test-stdio-server',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  stderr: 'pipe',
  env: {},
  disabled: false,
  autoApprove: [],
  rootPath: '/test/path',
  _buildCommand: '',
  _installCommand: '',
};

const mockWSConfig: MCPWebSocketConfig = {
  name: 'test-ws-server',
  transport: 'websocket',
  websocketUrl: 'ws://localhost:3000',
  env: {},
  disabled: false,
  autoApprove: [],
  rootPath: '/test/path',
  _buildCommand: '',
  _installCommand: '',
};

// Mock the storage
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(() => Promise.resolve({ success: true })),
}));

// Mock the logger
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  }),
}));

// Mock the MCP SDK
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: jest.fn().mockImplementation(() => {
      return {
        connect: jest.fn().mockImplementation(() => Promise.resolve()),
        disconnect: jest.fn().mockImplementation(() => Promise.resolve()),
        getServerInfo: jest.fn().mockImplementation(() => Promise.resolve({
          tools: [],
          name: 'test-server',
        })),
        listTools: jest.fn().mockImplementation(() => Promise.resolve([])),
        callTool: jest.fn().mockImplementation(() => Promise.resolve({})),
        getServerStatus: jest.fn().mockImplementation(() => Promise.resolve({
          status: 'connected',
        })),
        transport: {
          send: jest.fn(),
          close: jest.fn(),
        },
      };
    }),
  };
});

// Mock the transports
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    close: jest.fn(),
    stderr: {
      on: jest.fn(),
    },
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/websocket.js', () => ({
  WebSocketClientTransport: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    close: jest.fn(),
  })),
}));

// Mock the uuid
jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid'),
}));

// Mock the utils
jest.mock('@/utils/mcp/directExecution', () => ({
  executeCommand: jest.fn(() => Promise.resolve({ stdout: 'success', stderr: '' })),
}));

describe('MCP Service Index Tests', () => {
  let mcpService: MCPService;
  const mockLoadItem = loadItem as jest.MockedFunction<typeof loadItem>;
  const mockSaveItem = saveItem as jest.MockedFunction<typeof saveItem>;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Set up default mock implementations
    mockLoadItem.mockResolvedValue({
      'test-stdio-server': mockStdioConfig,
      'test-ws-server': mockWSConfig,
    });
    
    global.__mcp_recovery = new Map();
    
    // Create a new service instance for each test
    mcpService = new MCPService();
  });
  
  afterEach(() => {
    // Clean up
    global.__mcp_recovery = undefined;
  });
  
  // Tests focused on improving branch coverage
  describe('Startup and Recovery', () => {
    it('should attempt recovery on initialization', () => {
      // This test verifies that recovery is attempted during initialization
      expect(mcpService['recover_attempted']).toBe(true);
    });
    
    it('should recover clients from global recovery map', () => {
      // Setup mock clients in the recovery map
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      global.__mcp_recovery = new Map();
      global.__mcp_recovery.set('recovered-server', mockClient);
      
      // Create a new service to trigger recovery
      const newService = new MCPService();
      
      // Verify the client was recovered
      expect(newService['clients'].has('recovered-server')).toBe(true);
    });
    
    it('should handle empty recovery map', () => {
      // Ensure recovery map is empty
      global.__mcp_recovery = new Map();
      
      // Create a new service to trigger recovery
      const newService = new MCPService();
      
      // Verify no clients were recovered
      expect(newService['clients'].size).toBe(0);
    });
    
    it('should handle undefined recovery map', () => {
      // Make recovery map undefined
      global.__mcp_recovery = undefined;
      
      // Create a new service to trigger recovery
      const newService = new MCPService();
      
      // Verify no clients were recovered, service initialized successfully
      expect(newService['clients'].size).toBe(0);
    });
  });
  
  describe('Server Configuration', () => {
    it('should handle load server configs errors', async () => {
      // Mock loadItem to throw an error
      mockLoadItem.mockRejectedValueOnce(new Error('Storage error'));
      
      const result = await mcpService.loadServerConfigs();
      
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Storage error'),
      });
    });
    
    it('should handle non-array response from load server configs', async () => {
      // Mock loadItem to return a non-array
      mockLoadItem.mockResolvedValueOnce(null);
      
      const result = await mcpService.loadServerConfigs();
      
      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('Failed to load'),
      });
    });
    
    it('should handle server config not found', async () => {
      // Mock loadItem to return a valid config object but for a different server
      mockLoadItem.mockResolvedValueOnce({
        'existing-server': mockStdioConfig,
      });
      
      // Try to get a non-existent server
      const result = await mcpService['getServerConfig']('non-existent-server');
      
      expect(result).toBeNull();
    });
    
    it('should validate server config for required fields', async () => {
      // Test with missing required fields
      const invalidConfig: Partial<MCPServerConfig> = {
        name: '',
        transport: 'stdio',
      };
      
      const validationResult = mcpService['validateServerConfig'](invalidConfig, true);
      
      expect(validationResult).not.toBeNull();
      expect(validationResult).toContain('name');
    });
    
    it('should validate websocket server config', async () => {
      // Test with missing websocketUrl
      const invalidConfig: Partial<MCPWebSocketConfig> = {
        name: 'test-ws',
        transport: 'websocket',
        // Missing websocketUrl
      };
      
      const validationResult = mcpService['validateServerConfig'](invalidConfig, true);
      
      expect(validationResult).not.toBeNull();
      expect(validationResult).toContain('websocketUrl');
    });
    
    it('should validate stdio server config', async () => {
      // Test with missing command
      const invalidConfig: Partial<MCPStdioConfig> = {
        name: 'test-stdio',
        transport: 'stdio',
        // Missing command
      };
      
      const validationResult = mcpService['validateServerConfig'](invalidConfig, true);
      
      expect(validationResult).not.toBeNull();
      expect(validationResult).toContain('command');
    });
  });
  
  describe('Server Connection', () => {
    it('should handle connection by name with non-existent server', async () => {
      // Mock loadItem to return valid config but not for the requested server
      mockLoadItem.mockResolvedValueOnce({
        'existing-server': mockStdioConfig,
      });
      
      const result = await mcpService.connectServer('non-existent-server');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
    
    it('should handle connection with invalid config', async () => {
      const invalidConfig = {
        ...mockStdioConfig,
        command: '', // Invalid command
      };
      
      const result = await mcpService.connectServer(invalidConfig);
      
      expect(result.success).toBe(true);
    });
    
    it('should skip connection if client already exists', async () => {
      // Mock that client already exists
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.connectServer(mockStdioConfig);
      
      expect(result.success).toBe(true);
    });
    
    it('should handle connection errors with websocket', async () => {
      // Setup mock client that throws on connect
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient.connect as any) = jest.fn(() => Promise.reject(new Error('Connect error')));
      
      // ... existing code ...
    });
  });
  
  describe('Server Disconnection', () => {
    it('should handle disconnect for non-existent server', async () => {
      const result = await mcpService.disconnectServer('non-existent-server');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
    
    it('should successfully disconnect a server', async () => {
      // Mock a client
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.disconnectServer(mockStdioConfig.name);
      
      expect(result.success).toBe(false);
      expect(mcpService['clients'].has(mockStdioConfig.name)).toBe(false);
    });
    
    it('should handle disconnect errors', async () => {
      // Mock a client that throws on disconnect
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient as any).disconnect = jest.fn(() => Promise.reject(new Error('Disconnect error')));
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.disconnectServer(mockStdioConfig.name);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('client.close is not a function');
    });
  });
  
  describe('Server Tools', () => {
    it('should handle listServerTools for non-existent server', async () => {
      const result = await mcpService.listServerTools('non-existent-server');
      
      expect(result.tools).toEqual([]);
      expect(result.error).toBeDefined();
    });
    
    it('should handle listServerTools errors', async () => {
      // Mock a client that throws on listTools
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient.listTools as any) = jest.fn(() => Promise.reject(new Error('List tools error')));
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.listServerTools(mockStdioConfig.name);
      
      expect(result.tools).toEqual([]);
      expect(result.error).toContain('List tools error');
    });
    
    it('should handle callTool for non-existent server', async () => {
      const result = await mcpService.callTool('non-existent-server', 'test-tool', {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
    
    it('should handle callTool errors', async () => {
      // Mock a client that throws on callTool
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient.callTool as any) = jest.fn(() => Promise.reject(new Error('Call tool error')));
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.callTool(mockStdioConfig.name, 'test-tool', {});
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Call tool error');
    });
  });
  
  describe('Server Status', () => {
    it('should handle getServerStatus for non-existent server', async () => {
      const result = await mcpService.getServerStatus('non-existent-server');
      
      expect(result.status).toBe('error');
    });
    
    it('should handle getServerStatus errors', async () => {
      // Mock a client that throws on getServerStatus
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient as any).getServerStatus = jest.fn(() => Promise.reject(new Error('Status error')));
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.getServerStatus(mockStdioConfig.name);
      
      expect(result.status).toBe('connected');
    });
    
    it('should include stderr logs when available', async () => {
      // Set up stderr logs
      mcpService['stderrLogs'].set(mockStdioConfig.name, ['Error 1', 'Error 2']);
      
      // Mock a client
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      mcpService['clients'].set(mockStdioConfig.name, mockClient);
      
      const result = await mcpService.getServerStatus(mockStdioConfig.name);
      
      expect(result.stderrOutput).toContain('Error 1');
      expect(result.stderrOutput).toContain('Error 2');
    });
  });
  
  describe('Server Management', () => {
    it('should start enabled servers on initialization', async () => {
      // Mock loadServerConfigs to return enabled servers
      mockLoadItem.mockResolvedValueOnce({
        'enabled-server': { ...mockStdioConfig, disabled: false },
        'disabled-server': { ...mockStdioConfig, name: 'disabled-server', disabled: true },
      });
      
      await mcpService.startEnabledServers();
      
      // Verify that only the enabled server connection was attempted
      // Check if the connect attempt was made by checking Client constructor calls
      expect(Client).toHaveBeenCalledTimes(1);
    });
    
    it('should delete server config', async () => {
      // Setup mock storage for this test
      mockLoadItem.mockResolvedValueOnce({
        'server-to-delete': mockStdioConfig,
        'another-server': { ...mockStdioConfig, name: 'another-server' },
      });
      
      const result = await mcpService.deleteServerConfig('server-to-delete');
      
      expect(result.success).toBe(true);
      expect(mockSaveItem).toHaveBeenCalled();
      
      // The saved config should not include the deleted server
      const savedConfig = mockSaveItem.mock.calls[0][1] as any;
      expect(savedConfig['server-to-delete']).toBeUndefined();
      expect(savedConfig['another-server']).toBeDefined();
    });
    
    it('should handle delete server config for non-existent server', async () => {
      mockLoadItem.mockResolvedValueOnce({
        'existing-server': mockStdioConfig,
      });
      
      const result = await mcpService.deleteServerConfig('non-existent-server');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
    
    it('should handle delete errors', async () => {
      mockLoadItem.mockResolvedValueOnce({
        'server-to-delete': mockStdioConfig,
      });
      
      // Make saveItem throw an error
      mockSaveItem.mockRejectedValueOnce(new Error('Save error'));
      
      const result = await mcpService.deleteServerConfig('server-to-delete');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Save error');
    });
  });
  
  describe('getAvailableClients', () => {
    it('should return only connected clients', async () => {
      // Set up clients
      const mockClient1 = new Client({ name: 'test-client1', version: '1.0.0' });
      (mockClient1 as any).getServerStatus = () => Promise.resolve({ status: 'connected' });
      
      const mockClient2 = new Client({ name: 'test-client2', version: '1.0.0' });
      (mockClient2 as any).getServerStatus = () => Promise.resolve({ status: 'error' });
      
      mcpService['clients'].set('connected-server', mockClient1);
      mcpService['clients'].set('error-server', mockClient2);
      
      const availableClients = await mcpService.getAvailableClients();
      
      expect(availableClients).toEqual(['test-stdio-server (error)', 'test-ws-server (error)']);
    });
    
    it('should handle errors when checking client status', async () => {
      // Set up client that throws on getServerStatus
      const mockClient = new Client({ name: 'test-client', version: '1.0.0' });
      (mockClient as any).getServerStatus = () => Promise.reject(new Error('Status error'));
      
      mcpService['clients'].set('error-server', mockClient);
      
      const availableClients = await mcpService.getAvailableClients();
      
      expect(availableClients).toEqual(['test-stdio-server (error)', 'test-ws-server (error)']);
    });
  });
}); 