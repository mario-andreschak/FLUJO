import { 
  createNewClient, 
  createTransport, 
  createStdioTransport,
  shouldRecreateClient, 
  safelyCloseClient 
} from '../connection';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { MCPServerConfig, MCPStdioConfig, MCPWebSocketConfig, SERVER_DIR_PREFIX } from '@/shared/types/mcp';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock dependencies
jest.mock('fs');
jest.mock('os');
jest.mock('path');
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  })),
}));

// Add this helper function to test for stdio config
function isStdioConfig(config: MCPServerConfig): config is MCPStdioConfig {
  return config.transport === 'stdio';
}

describe('MCP Connection', () => {
  const mockConfig: MCPServerConfig = {
    name: 'test-server',
    transport: 'stdio',
    command: 'test-command',
    args: ['--test'],
    stderr: 'pipe',
    rootPath: '/test/path',
    disabled: false,
    autoApprove: [],
    env: {},
    _buildCommand: '',
    _installCommand: '',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default mocks
    (os.platform as jest.Mock).mockReturnValue('linux');
    (path.isAbsolute as jest.Mock).mockReturnValue(false);
    (path.join as jest.Mock).mockImplementation((...parts) => parts.join('/'));
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    (process.cwd as jest.Mock) = jest.fn().mockReturnValue('/mock/cwd');
  });

  describe('createNewClient', () => {
    test('should create a new client with correct configuration', () => {
      const client = createNewClient(mockConfig);
      // Check client properties without accessing private fields
      expect(client).toBeInstanceOf(Client);
      expect(client.request).toBeDefined();
    });
  });

  describe('createTransport', () => {
    test('should create WebSocket transport', () => {
      const wsConfig = {
        ...mockConfig,
        transport: 'websocket',
        websocketUrl: 'ws://localhost:3000'
      } as MCPWebSocketConfig;
      const transport = createTransport(wsConfig);
      expect(transport).toBeInstanceOf(WebSocketClientTransport);
    });

    test('should create stdio transport', () => {
      (os.platform as jest.Mock).mockReturnValue('linux');
      const transport = createTransport(mockConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    test('should handle Windows bat files', () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      const winConfig = {
        ...mockConfig,
        command: 'test.bat'
      } as MCPStdioConfig;
      const transport = createTransport(winConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    test('should throw error when trying to create stdio transport from websocket config', () => {
      const wsConfig = {
        ...mockConfig,
        transport: 'websocket',
        websocketUrl: 'ws://localhost:3000'
      } as MCPWebSocketConfig;
      
      expect(() => {
        createStdioTransport(wsConfig);
      }).toThrow('Cannot create stdio transport for non-stdio config');
    });
  });

  describe('createStdioTransport', () => {
    test('should create a stdio transport with correct configuration', () => {
      const transport = createStdioTransport(mockConfig as MCPStdioConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
    });

    test('should handle Windows bat files with just filename', () => {
      // Setup mocks for Windows bat file test
      (os.platform as jest.Mock).mockReturnValue('win32');
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (path.isAbsolute as jest.Mock).mockReturnValue(false);
      (path.join as jest.Mock).mockImplementation((...args: string[]) => args.join('\\'));
      
      const winConfig = {
        ...mockConfig,
        command: 'test.bat'
      } as MCPStdioConfig;
      
      const transport = createStdioTransport(winConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify command and args
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.command).toBe('cmd.exe');
      expect(serverParams.args).toContain('/c');
      expect(serverParams.args.some((arg: string) => arg.includes('test.bat'))).toBe(true);
    });

    test('should handle Windows bat files that do not exist', () => {
      // Setup mocks for Windows bat file test with non-existent file
      (os.platform as jest.Mock).mockReturnValue('win32');
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      (path.isAbsolute as jest.Mock).mockReturnValue(false);
      
      const winConfig = {
        ...mockConfig,
        command: 'test.bat'
      } as MCPStdioConfig;
      
      const transport = createStdioTransport(winConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify command and args
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.command).toBe('cmd.exe');
      expect(serverParams.args).toContain('/c');
      expect(serverParams.args).toContain('test.bat');
    });

    test('should handle Windows bat files with relative path', () => {
      // Setup mocks for Windows bat file test with relative path
      (os.platform as jest.Mock).mockReturnValue('win32');
      (path.isAbsolute as jest.Mock).mockReturnValue(false);
      
      const winConfig = {
        ...mockConfig,
        command: './subfolder/test.bat'
      } as MCPStdioConfig;
      
      const transport = createStdioTransport(winConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify command and args
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.command).toBe('cmd.exe');
      expect(serverParams.args).toContain('/c');
      expect(serverParams.args).toContain('./subfolder/test.bat');
    });

    test('should handle Windows bat files with absolute path', () => {
      // Setup mocks for Windows bat file test with absolute path
      (os.platform as jest.Mock).mockReturnValue('win32');
      (path.isAbsolute as jest.Mock).mockReturnValue(true);
      
      const winConfig = {
        ...mockConfig,
        command: 'C:\\path\\to\\test.bat'
      } as MCPStdioConfig;
      
      const transport = createStdioTransport(winConfig);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify command and args
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.command).toBe('cmd.exe');
      expect(serverParams.args).toContain('/c');
      expect(serverParams.args).toContain('C:\\path\\to\\test.bat');
    });

    test('should handle env variables with metadata', () => {
      // Define a type for the mock config that includes complex env variables
      type MockConfigWithComplexEnv = Omit<MCPServerConfig, 'env'> & {
        env: {
          API_KEY: { value: string; metadata: { isSecret: boolean } };
          DEBUG: string;
        };
      };
      
      const configWithEnvMetadata = {
        ...mockConfig,
        env: {
          API_KEY: { value: 'secret-key', metadata: { isSecret: true } },
          DEBUG: 'true'
        }
      } as unknown as MCPServerConfig; // Use type assertion to bypass TypeScript checks for the test
      
      const transport = createStdioTransport(configWithEnvMetadata);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify env
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.env.API_KEY).toBe('secret-key');
      expect(serverParams.env.DEBUG).toBe('true');
    });

    test('should use server directory as cwd when rootPath and cwd are not provided', () => {
      // Create a config without rootPath for testing
      const configWithoutRootPath = {
        ...mockConfig,
        transport: 'stdio',
        command: 'test-command',
        args: ['--test'],
        stderr: 'pipe',
        name: 'test-server',
        disabled: false,
        autoApprove: [],
        env: {},
        _buildCommand: '',
        _installCommand: '',
        rootPath: '' // Empty rootPath
      } as MCPStdioConfig;  
      
      const transport = createStdioTransport(configWithoutRootPath);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify cwd
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.cwd).toBe(`${SERVER_DIR_PREFIX}/${configWithoutRootPath.name}`);
    });

    test('should prioritize rootPath over cwd', () => {
      // The real issue is that cwd isn't declared in MCPServerConfig
      // We'll use type assertion to allow the test to pass while keeping its intent
      const configWithBothPaths = {
        ...mockConfig,
        rootPath: '/root/path',
        // Add cwd for testing purposes, even though it's not in the type
      } as MCPServerConfig & { cwd: string };
      
      // Dynamically add the cwd property to avoid TypeScript error
      (configWithBothPaths as any).cwd = '/other/path';
      
      const transport = createStdioTransport(configWithBothPaths);
      expect(transport).toBeInstanceOf(StdioClientTransport);
      
      // Access private fields to verify cwd
      const serverParams = (transport as any)._serverParams;
      expect(serverParams.cwd).toBe('/root/path');
    });
  });

  describe('shouldRecreateClient', () => {
    let mockStdioClient: Client;
    let mockWebSocketClient: Client;
    
    beforeEach(() => {
      // Create mock stdio client
      mockStdioClient = {
        transport: new StdioClientTransport({ command: 'test-command', args: ['--test'] }),
        request: jest.fn(),
        close: jest.fn(),
      } as unknown as Client;
      
      // Add _serverParams to simulate private field
      (mockStdioClient.transport as any)._serverParams = { 
        command: 'test-command', 
        args: ['--test'],
        env: {}
      };
      
      // Create mock websocket client
      mockWebSocketClient = {
        transport: new WebSocketClientTransport(new URL('ws://localhost:3000')),
        request: jest.fn(),
        close: jest.fn(),
      } as unknown as Client;
    });

    test('should detect transport type changes from stdio to websocket', () => {
      const wsConfig = {
        ...mockConfig,
        transport: 'websocket',
        websocketUrl: 'ws://localhost:3000'
      } as MCPWebSocketConfig;
      
      const result = shouldRecreateClient(mockStdioClient, wsConfig);
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toContain('Transport type changed from stdio to websocket');
    });

    test('should detect transport type changes from websocket to stdio', () => {
      const result = shouldRecreateClient(mockWebSocketClient, mockConfig);
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toContain('Transport type changed from websocket to stdio');
    });

    test('should detect command changes in stdio transport', () => {
      const modifiedConfig = {
        ...mockConfig,
        command: 'new-command'
      } as MCPStdioConfig;
      
      const result = shouldRecreateClient(mockStdioClient, modifiedConfig);
      
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toBe('Connection parameters changed');
    });

    test('should detect args changes in stdio transport', () => {
      const modifiedConfig = {
        ...mockConfig,
        args: ['--new-flag']
      } as MCPStdioConfig;
      
      const result = shouldRecreateClient(mockStdioClient, modifiedConfig);
      
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toBe('Connection parameters changed');
    });

    test('should detect env changes in stdio transport', () => {
      const modifiedConfig = {
        ...mockConfig,
        env: { NEW_VAR: 'value' }
      } as MCPStdioConfig;
      
      const result = shouldRecreateClient(mockStdioClient, modifiedConfig);
      
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toBe('Connection parameters changed');
    });

    test('should not recreate client when parameters have not changed', () => {
      // Ensure _serverParams matches mockConfig
      (mockStdioClient.transport as any)._serverParams = { 
        command: (mockConfig as MCPStdioConfig).command, 
        args: (mockConfig as MCPStdioConfig).args,
        env: mockConfig.env
      };
      
      const result = shouldRecreateClient(mockStdioClient, mockConfig);
      expect(result.needsNewClient).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    test('should handle case when _serverParams is not accessible', () => {
      // Remove _serverParams to simulate inaccessible property
      delete (mockStdioClient.transport as any)._serverParams;
      
      const result = shouldRecreateClient(mockStdioClient, mockConfig);
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toBe('Cannot access transport options');
    });

    test('should handle case when transport is of wrong type', () => {
      // Create a client with a non-standard transport
      const clientWithWrongTransport = {
        transport: {},
        request: jest.fn(),
        close: jest.fn(),
      } as unknown as Client;
      
      const result = shouldRecreateClient(clientWithWrongTransport, mockConfig);
      expect(result.needsNewClient).toBe(true);
    });

    test('should detect config type change in shouldRecreateClient', () => {
      const stdioConfig = {
        ...mockConfig,
        transport: 'stdio'
      } as MCPStdioConfig;
      
      // First test with the right transport type but wrong config
      (mockStdioClient.transport as any)._serverParams = { command: 'test' };
      
      // Create a websocket config
      const wsConfig = {
        ...mockConfig,
        transport: 'websocket',
        websocketUrl: 'ws://localhost:3000'
      } as MCPWebSocketConfig;
      
      const result = shouldRecreateClient(mockStdioClient, wsConfig);
      expect(result.needsNewClient).toBe(true);
      expect(result.reason).toContain('Transport type changed');
    });

    test('should check command/args/env correctly', async () => {
      // Create a test function that uses the type guard
      function checkStdioConfig(config: MCPServerConfig) {
        if (isStdioConfig(config)) {
          // Now we can safely access these fields
          return {
            command: config.command,
            args: config.args
          };
        }
        return null;
      }

      const result = checkStdioConfig(mockConfig);
      expect(result).toEqual({
        command: 'test-command',
        args: ['--test']
      });
    });
  });

  describe('safelyCloseClient', () => {
    test('should close stdio client gracefully', async () => {
      const mockStdin = {
        end: jest.fn(),
        destroyed: false,
        writable: true
      };

      const mockProcess = {
        stdin: mockStdin,
        killed: false,
        kill: jest.fn(),
        once: jest.fn().mockImplementation((event, callback) => {
          process.nextTick(() => callback(0));
          return mockProcess;
        }),
        removeAllListeners: jest.fn()
      } as unknown as ChildProcess;

      const mockStdioTransport = {
        _process: mockProcess,
        _serverParams: { command: 'test' },
        close: jest.fn().mockImplementation(() => {
          if (!mockProcess.killed && mockProcess.stdin && !mockProcess.stdin.destroyed) {
            mockProcess.stdin.end();
          }
        })
      } as unknown as StdioClientTransport;

      const mockClient = {
        transport: mockStdioTransport,
        close: jest.fn().mockImplementation(async () => {
          await mockStdioTransport.close();
        })
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockStdin.end).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });

    test('should handle case where stdin is already destroyed', async () => {
      const mockStdin = {
        end: jest.fn(),
        destroyed: true,
        writable: false
      };

      const mockProcess = {
        stdin: mockStdin,
        killed: false,
        kill: jest.fn(),
        once: jest.fn(),
        removeAllListeners: jest.fn()
      } as unknown as ChildProcess;

      const mockStdioTransport = {
        _process: mockProcess,
        close: jest.fn()
      } as unknown as StdioClientTransport;

      const mockClient = {
        transport: mockStdioTransport,
        close: jest.fn()
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockStdin.end).not.toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });

    test('should handle case where process is already killed', async () => {
      const mockProcess = {
        stdin: null,
        killed: true,
        kill: jest.fn(),
        once: jest.fn(),
        removeAllListeners: jest.fn()
      } as unknown as ChildProcess;

      const mockStdioTransport = {
        _process: mockProcess,
        close: jest.fn()
      } as unknown as StdioClientTransport;

      const mockClient = {
        transport: mockStdioTransport,
        close: jest.fn()
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockProcess.kill).not.toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });

    test('should handle case where process is undefined', async () => {
      const mockStdioTransport = {
        _process: undefined,
        close: jest.fn()
      } as unknown as StdioClientTransport;

      const mockClient = {
        transport: mockStdioTransport,
        close: jest.fn()
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockClient.close).toHaveBeenCalled();
    });

    test('should handle case where process.stdin is undefined', async () => {
      const mockProcess = {
        stdin: undefined,
        killed: false,
        kill: jest.fn(),
        once: jest.fn(),
        removeAllListeners: jest.fn()
      } as unknown as ChildProcess;

      const mockStdioTransport = {
        _process: mockProcess,
        close: jest.fn()
      } as unknown as StdioClientTransport;

      const mockClient = {
        transport: mockStdioTransport,
        close: jest.fn()
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockClient.close).toHaveBeenCalled();
    });
    
    test('should handle errors during close', async () => {
      const mockClient = {
        transport: {},
        close: jest.fn().mockRejectedValue(new Error('Close error'))
      } as unknown as Client;

      await expect(safelyCloseClient(mockClient, 'test-server')).resolves.not.toThrow();
    });

    test('should handle WebSocket transport', async () => {
      const mockWsTransport = new WebSocketClientTransport(new URL('ws://localhost:3000'));
      const mockClient = {
        transport: mockWsTransport,
        close: jest.fn()
      } as unknown as Client;

      await safelyCloseClient(mockClient, 'test-server');
      
      expect(mockClient.close).toHaveBeenCalled();
    });
  });
}); 