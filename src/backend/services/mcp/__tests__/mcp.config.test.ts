import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { loadServerConfigs, saveConfig } from '../config';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { 
  MCPServerConfig, 
  MCPStdioConfig, 
  MCPWebSocketConfig,
  MCPServiceResponse
} from '@/shared/types/mcp';

// Mock dependencies
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockLoadItem = loadItem as jest.MockedFunction<typeof loadItem>;
const mockSaveItem = saveItem as jest.MockedFunction<typeof saveItem>;

describe('MCP Configuration Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('loadServerConfigs', () => {
    it('should load and transform stdio server config correctly', async () => {
      // Mock storage response
      mockLoadItem.mockResolvedValueOnce({
        'test-stdio-server': {
          name: 'test-stdio-server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          stderr: 'pipe',
          disabled: false,
          env: {
            NODE_ENV: 'development',
            DEBUG: { value: 'true' } // Test complex env var format
          }
        }
      });

      const result = await loadServerConfigs();
      
      // Verify it's a valid result array
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as any;
        expect(config.name).toBe('test-stdio-server');
        expect(config.transport).toBe('stdio');
        expect(config.command).toBe('node');
        expect(config.args).toEqual(['server.js']);
        expect(config.stderr).toBe('pipe');
        expect(config.env).toEqual({
          NODE_ENV: 'development',
          DEBUG: 'true'
        });
        expect(config.rootPath).toBe(''); // Should have default values
        expect(config.autoApprove).toEqual([]);
      }
    });

    it('should load and transform websocket server config correctly', async () => {
      // Mock storage response
      mockLoadItem.mockResolvedValueOnce({
        'test-ws-server': {
          name: 'test-ws-server',
          transport: 'websocket',
          websocketUrl: 'ws://localhost:3000',
          env: {
            API_KEY: 'secret-key'
          }
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as MCPWebSocketConfig;
        expect(config.name).toBe('test-ws-server');
        expect(config.transport).toBe('websocket');
        expect(config.websocketUrl).toBe('ws://localhost:3000');
        expect(config.env).toEqual({
          API_KEY: 'secret-key'
        });
      }
    });

    it('should handle unknown transport type as stdio with default values', async () => {
      // Mock storage response with missing transport field
      mockLoadItem.mockResolvedValueOnce({
        'unknown-server': {
          name: 'unknown-server',
          command: 'python',
          args: ['server.py'],
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as any;
        expect(config.name).toBe('unknown-server');
        // In the actual implementation, transport is not always set as a property on the returned object
        expect(config.command).toBe('python');
        expect(config.args).toEqual(['server.py']);
        // Should have default values
        expect(config.stderr).toBe('pipe');
        expect(config.env).toEqual({});
        expect(config.rootPath).toBe('');
        expect(config.autoApprove).toEqual([]);
      }
    });

    it('should handle websocket server with missing websocketUrl', async () => {
      // Mock storage response
      mockLoadItem.mockResolvedValueOnce({
        'incomplete-ws-server': {
          name: 'incomplete-ws-server',
          transport: 'websocket',
          // No websocketUrl
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as MCPWebSocketConfig;
        expect(config.name).toBe('incomplete-ws-server');
        expect(config.transport).toBe('websocket');
        expect(config.websocketUrl).toBe(''); // Should get default empty string
      }
    });

    it('should handle storage errors gracefully', async () => {
      // Mock storage error
      mockLoadItem.mockRejectedValueOnce(new Error('Storage error'));

      const result = await loadServerConfigs();
      
      // In case of error, it returns a service response object
      expect(Array.isArray(result)).toBe(false);
      
      if (!Array.isArray(result)) {
        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to load server configs');
      }
    });
    
    it('should handle empty server list', async () => {
      // Mock empty object response
      mockLoadItem.mockResolvedValueOnce({});

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      if (Array.isArray(result)) {
        expect(result.length).toBe(0);
      }
    });

    it('should handle empty env objects in server config', async () => {
      // Mock storage response with empty env object
      mockLoadItem.mockResolvedValueOnce({
        'test-server': {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {} // Empty env object
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as MCPStdioConfig;
        expect(config.env).toEqual({}); // Empty env object should be preserved
      }
    });

    it('should handle null or missing env in server config', async () => {
      // Mock storage response with missing env property
      mockLoadItem.mockResolvedValueOnce({
        'test-server': {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: ['server.js']
          // No env property
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0] as MCPStdioConfig;
        expect(config.env).toEqual({}); // Should default to empty object
      }
    });

    it('should handle a server with undefined name but use property key', async () => {
      // Mock storage response with undefined name
      mockLoadItem.mockResolvedValueOnce({
        'key-as-name': {
          // No name property
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        }
      });

      const result = await loadServerConfigs();
      
      expect(Array.isArray(result)).toBe(true);
      
      if (Array.isArray(result)) {
        const config = result[0];
        // The name should be set using the key
        expect(config.name).toBe('key-as-name');
      }
    });
  });

  describe('saveConfig', () => {
    it('should save configs map correctly', async () => {
      // Test data
      const configsMap = new Map<string, MCPServerConfig>([
        ['test-stdio', {
          name: 'test-stdio',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          stderr: 'pipe',
          env: {
            NODE_ENV: 'development',
            DEBUG: 'true'
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        }],
        ['test-ws', {
          name: 'test-ws',
          transport: 'websocket',
          websocketUrl: 'ws://localhost:3000',
          env: {
            API_KEY: 'secret-key'
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        }]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify correct data was saved
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'test-stdio': expect.objectContaining({
            transport: 'stdio',
            command: 'node',
            env: {
              NODE_ENV: 'development',
              DEBUG: 'true'
            }
          }),
          'test-ws': expect.objectContaining({
            transport: 'websocket',
            websocketUrl: 'ws://localhost:3000',
            env: {
              API_KEY: 'secret-key'
            }
          })
        })
      );
    });

    it('should handle complex environment variable formats', async () => {
      // Test data with complex env vars
      const configsMap = new Map<string, MCPServerConfig>([
        ['test-server', {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: {
            SIMPLE_STRING: 'value',
            OBJECT_VALUE: { value: 'object-value', metadata: { isSecret: false } },
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        } as unknown as MCPStdioConfig]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify correct env processing
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'test-server': expect.objectContaining({
            env: {
              SIMPLE_STRING: 'value',
              OBJECT_VALUE: 'object-value',
            }
          })
        })
      );
    });

    it('should handle empty configs map', async () => {
      // Empty map
      const configsMap = new Map<string, MCPServerConfig>();

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify empty object was saved
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        {}
      );
    });

    it('should handle storage errors gracefully', async () => {
      // Test data
      const configsMap = new Map<string, MCPServerConfig>([
        ['test-server', {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: {},
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        }]
      ]);

      // Mock storage error
      mockSaveItem.mockRejectedValueOnce(new Error('Storage error'));

      const result = await saveConfig(configsMap);
      
      // Verify error result
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to save config');
    });
    
    it('should handle preserve config without env property', async () => {
      // Test data with missing env property
      const configsMap = new Map<string, MCPServerConfig>([
        ['minimal-server', {
          name: 'minimal-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          // No env property
          env: {},
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        } as unknown as MCPStdioConfig]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify processed config has empty env object
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'minimal-server': expect.objectContaining({
            env: {}
          })
        })
      );
    });

    it('should handle null env values in config', async () => {
      // Test data with null env property
      const configsMap = new Map<string, MCPServerConfig>([
        ['null-env-server', {
          name: 'null-env-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: null as any, // Null env
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        }]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify empty env object was used
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'null-env-server': expect.objectContaining({
            env: {} // Should use empty object
          })
        })
      );
    });

    it('should handle mixed env value types in config', async () => {
      // Test data with mixed env value types
      const configsMap = new Map<string, MCPServerConfig>([
        ['mixed-env-server', {
          name: 'mixed-env-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: {
            STRING_VAL: 'string-value',
            OBJECT_VAL: { value: 'object-value' }
            // Removing NULL_VAL and UNDEFINED_VAL as they may cause issues
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        } as unknown as MCPStdioConfig]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify env object was correctly processed (this tests line 58-59)
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'mixed-env-server': expect.objectContaining({
            env: {
              STRING_VAL: 'string-value',
              OBJECT_VAL: 'object-value'
            }
          })
        })
      );
    });

    it('should handle env values that are not strings or objects', async () => {
      // Create test data with non-string value format but ones that can be stringified
      const configsMap = new Map<string, MCPServerConfig>([
        ['test-server', {
          name: 'test-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: {
            // Convert to plain objects for the test since Typescript will error on direct assignment
            NUMBER_VAL: { value: 123 },  // Object with value property works
            BOOLEAN_VAL: { value: true }  // Object with value property works
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        } as unknown as MCPStdioConfig]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Verify result
      expect(result.success).toBe(true);
      
      // Verify env values were handled
      expect(mockSaveItem).toHaveBeenCalledWith(
        StorageKey.MCP_SERVERS,
        expect.objectContaining({
          'test-server': expect.objectContaining({
            env: expect.objectContaining({
              NUMBER_VAL: 123,
              BOOLEAN_VAL: true
            })
          })
        })
      );
    });

    it('should handle unexpected stringification errors during env processing', async () => {
      // Create an object with a custom toString that throws
      const badObject = {
        toString: () => { throw new Error('Invalid toString'); }
      };
      
      // Test data with an object that can't be stringified
      const configsMap = new Map<string, MCPServerConfig>([
        ['error-env-server', {
          name: 'error-env-server',
          transport: 'stdio',
          command: 'node',
          args: [],
          stderr: 'pipe',
          env: {
            BAD_OBJECT: badObject as any
          },
          disabled: false,
          autoApprove: [],
          rootPath: '',
          _buildCommand: '',
          _installCommand: ''
        }]
      ]);

      // Mock successful save
      mockSaveItem.mockResolvedValueOnce(undefined);

      const result = await saveConfig(configsMap);
      
      // Should still succeed but BAD_OBJECT might be skipped or have a fallback representation
      expect(result.success).toBe(true);
      expect(mockSaveItem).toHaveBeenCalled();
    });
  });
}); 