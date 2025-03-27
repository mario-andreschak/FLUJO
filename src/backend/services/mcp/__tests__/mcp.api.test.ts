import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mcpService } from '../index';
import { MCPServerConfig, MCPStdioConfig, MCPServiceResponse } from '@/shared/types/mcp';
import { StorageKey } from '@/shared/types/storage';
import { loadItem, saveItem } from '@/utils/storage/backend';

// Mock the storage utilities
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn().mockImplementation(async () => {})
}));

const mockLoadItem = loadItem as jest.MockedFunction<typeof loadItem>;
const mockSaveItem = saveItem as jest.MockedFunction<typeof saveItem>;

describe('MCP API Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Setup default mock responses
    mockLoadItem.mockImplementation(async <T>(key: StorageKey, defaultValue: T): Promise<T> => {
      if (key === StorageKey.MCP_SERVERS) {
        return {
          'test-server': {
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
        } as unknown as T;
      }
      return defaultValue;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Server Installation and Configuration', () => {
    const testServerConfig: MCPStdioConfig = {
      name: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {
        PORT: '3000',
        NODE_ENV: 'test'
      },
      disabled: false,
      autoApprove: [],
      _buildCommand: 'npm run build',
      _installCommand: 'npm install',
      rootPath: '/test/path',
      stderr: 'inherit'
    };

    it('should create a new server configuration', async () => {
      const result = await mcpService.updateServerConfig('test-server', testServerConfig);
      expect(result).toHaveProperty('name', 'test-server');
      expect(result).not.toHaveProperty('error');
    });

    it('should handle invalid server configuration', async () => {
      const invalidConfig: Partial<MCPStdioConfig> = {
        transport: 'stdio',
        command: 'invalid',
        args: [],
        _buildCommand: '',
        _installCommand: '',
        stderr: 'inherit' as const,
        // Missing required fields: name, env, disabled, autoApprove, rootPath
      };
      const result = await mcpService.updateServerConfig('invalid-server', invalidConfig);
      expect('error' in result).toBe(true);
      expect((result as MCPServiceResponse).error).toContain('Invalid server configuration');
    });
  });

  describe('Environment Secrets Management', () => {
    const testSecrets = {
      API_KEY: 'test-api-key',
      DATABASE_URL: 'test-db-url'
    };

    it('should set environment secrets', async () => {
      const result = await mcpService.updateServerConfig('test-server', {
        env: testSecrets
      });
      expect(result).not.toHaveProperty('error');
      const config = result as MCPServerConfig;
      expect(config.env).toEqual(testSecrets);
    });

    it('should get environment secrets', async () => {
      const configs = await mcpService.loadServerConfigs();
      expect(Array.isArray(configs)).toBe(true);
      const config = (configs as MCPServerConfig[]).find(c => c.name === 'test-server');
      expect(config).toBeDefined();
      expect(config?.env).toEqual({});
    });
  });

  describe('Server Management Operations', () => {
    it('should get server status', async () => {
      const status = await mcpService.getServerStatus('test-server');
      expect(status).toHaveProperty('status');
    });

    it('should handle non-existent server status', async () => {
      const status = await mcpService.getServerStatus('non-existent-server');
      expect(status.status).toBe('error');
    });

    it('should delete server configuration', async () => {
      mockLoadItem.mockImplementationOnce(async <T>(key: StorageKey, defaultValue: T): Promise<T> => ({
        'test-server': {
          transport: 'stdio',
          command: 'node',
          args: ['server.js']
        }
      } as unknown as T));
      const result = await mcpService.deleteServerConfig('test-server');
      expect(result.success).toBe(true);
    });

    it('should handle deleting non-existent server', async () => {
      mockLoadItem.mockImplementationOnce(async <T>(key: StorageKey, defaultValue: T): Promise<T> => ({} as T));
      const result = await mcpService.deleteServerConfig('non-existent-server');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
}); 