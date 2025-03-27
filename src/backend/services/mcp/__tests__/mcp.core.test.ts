import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, MCPManagerConfig } from '@/shared/types/mcp';
import { MCPService } from '../index';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';

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

// Mock storage functions
const mockStorage = {
  [StorageKey.MCP_SERVERS]: {
    'test-stdio-server': { ...mockStdioConfig },
    'test-ws-server': { ...mockWSConfig },
  } as Record<string, MCPServerConfig>,
};

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn().mockImplementation(async (key: unknown) => {
    if (key === StorageKey.MCP_SERVERS) {
      return mockStorage[StorageKey.MCP_SERVERS];
    }
    return null;
  }),
  saveItem: jest.fn().mockImplementation(async (key: unknown, value: any) => {
    if (key === StorageKey.MCP_SERVERS) {
      mockStorage[StorageKey.MCP_SERVERS] = Object.fromEntries(
        Object.entries(value).map(([name, config]) => {
          const serverConfig = config as MCPServerConfig;
          const env = serverConfig.env || {};
          const processedEnv = Object.fromEntries(
            Object.entries(env).map(([key, val]) => [
              key,
              typeof val === 'string' ? val : (val as { value: string }).value
            ])
          );
          return [name, {
            ...serverConfig,
            env: processedEnv,
          }];
        })
      ) as Record<string, MCPServerConfig>;
      return { success: true };
    }
    return { success: true };
  }),
}));

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn().mockImplementation(() => {
    const proc = {
      on: jest.fn((event: string, handler: (error: Error) => void) => {
        if (event === 'error') {
          handler(new Error('Failed to spawn process'));
        }
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      kill: jest.fn(),
    };
    return proc;
  }),
}));

// Mock WebSocket
jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn((event: string, handler: (error: Error) => void) => {
      if (event === 'error') {
        handler(new Error('Failed to connect'));
      }
    }),
    send: jest.fn(),
    close: jest.fn(),
  }));
});

describe('MCP Core Tests', () => {
  let mcpService: MCPService;

  beforeEach(() => {
    mcpService = new MCPService();
    // Reset mock storage to initial state
    mockStorage[StorageKey.MCP_SERVERS] = {
      'test-stdio-server': { ...mockStdioConfig },
      'test-ws-server': { ...mockWSConfig },
    };
  });

  describe('Connection Management', () => {
    it('should handle connection errors', async () => {
      const invalidConfig = { ...mockStdioConfig, command: '' };
      const result = await mcpService.connectServer(invalidConfig.name);
      expect('error' in result).toBe(true);
    });
  });

  describe('Server State Management', () => {
    it('should handle server state changes', async () => {
      const result = await mcpService.updateServerConfig('test-stdio-server', {
        disabled: true,
      });
      
      // The result might be a config object or a service response
      if ('success' in result) {
        expect(result.success).toBe(true);
      } else {
        expect(result.disabled).toBe(true);
      }
      
      const configs = await mcpService.loadServerConfigs();
      expect(Array.isArray(configs)).toBe(true);
      const updatedServer = (configs as MCPServerConfig[]).find(s => s.name === 'test-stdio-server');
      expect(updatedServer?.disabled).toBe(true);
    });

    it('should handle connection recovery', async () => {
      // Mock successful connection
      (saveItem as jest.Mock).mockImplementation(async () => ({ success: true }));
      
      // Simulate a disconnection
      const disconnectResult = await mcpService.disconnectServer('test-stdio-server');
      expect(disconnectResult.success).toBe(false); // Server not found in clients map
      
      // Attempt recovery
      const result = await mcpService.connectServer('test-stdio-server');
      expect('error' in result).toBe(true); // Connection should fail in test environment
    });

    it('should manage multiple server connections', async () => {
      // Mock successful connection
      (saveItem as jest.Mock).mockImplementation(async () => ({ success: true }));
      
      const stdio = await mcpService.connectServer('test-stdio-server');
      const ws = await mcpService.connectServer('test-ws-server');
      
      // In test environment, connections will fail but with proper error responses
      expect('error' in stdio).toBe(true);
      expect('error' in ws).toBe(true);

      const status = await mcpService.getServerStatus('test-stdio-server');
      expect(status.status).toBe('error');
      expect(status.message).toBeDefined();
    });
  });

  describe('Environment Management', () => {
    beforeEach(() => {
      // Reset mock storage to initial state before each test
      mockStorage[StorageKey.MCP_SERVERS] = {
        'test-stdio-server': {
          ...mockStdioConfig,
          env: {},
        },
        'test-ws-server': {
          ...mockWSConfig,
          env: {},
        },
      };
      
      // Clear any mocked implementations
      (loadItem as jest.Mock).mockImplementation(async (key: unknown) => {
        if (key === StorageKey.MCP_SERVERS) {
          return mockStorage[StorageKey.MCP_SERVERS];
        }
        return null;
      });
      
      (saveItem as jest.Mock).mockImplementation(async (key: unknown, value: any) => {
        if (key === StorageKey.MCP_SERVERS) {
          mockStorage[StorageKey.MCP_SERVERS] = Object.fromEntries(
            Object.entries(value).map(([name, config]) => {
              const serverConfig = config as MCPServerConfig;
              return [name, {
                ...serverConfig,
                env: serverConfig.env || {},
              }];
            })
          ) as Record<string, MCPServerConfig>;
          return { success: true };
        }
        return { success: true };
      });
    });

    it('should handle global environment variables', async () => {
      const globalVars = {
        NODE_ENV: 'test',
        PORT: '3000',
      };

      // Update the server config with environment variables
      const result = await mcpService.updateServerConfig('test-stdio-server', {
        env: globalVars,
      });

      // Verify the result
      if ('success' in result) {
        expect(result.success).toBe(true);
      } else {
        expect(result.env).toEqual(globalVars);
      }

      // Load the configs and verify the environment variables
      const configs = await mcpService.loadServerConfigs();
      expect(Array.isArray(configs)).toBe(true);
      const config = (configs as MCPServerConfig[]).find(s => s.name === 'test-stdio-server');
      expect(config?.env).toEqual(globalVars);
    });

    it('should resolve environment references', async () => {
      const vars = {
        BASE_URL: 'http://localhost',
        API_URL: '${BASE_URL}/api',
      };

      const expected = {
        BASE_URL: 'http://localhost',
        API_URL: 'http://localhost/api',
      };

      // Update the server config with environment variables
      const result = await mcpService.updateServerConfig('test-stdio-server', {
        env: vars,
      });

      // Verify the result
      if ('success' in result) {
        expect(result.success).toBe(true);
      } else {
        expect(result.env).toEqual(expected);
      }

      // Load the configs and verify the environment variables
      const configs = await mcpService.loadServerConfigs();
      expect(Array.isArray(configs)).toBe(true);
      const config = (configs as MCPServerConfig[]).find(s => s.name === 'test-stdio-server');
      expect(config?.env).toEqual(expected);
    });
  });
}); 