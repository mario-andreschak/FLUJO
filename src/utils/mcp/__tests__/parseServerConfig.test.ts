import { parseServerConfig } from '../parseServerConfig';
import { MCPServerConfig, MCPWebSocketConfig } from '@/shared/types/mcp';
import { ParsedServerConfig } from '../types';

// Define a type that includes all possible config properties we're testing
type TestMCPConfig = {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
  _buildCommand?: string;
  _installCommand?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
};

// Mock dependencies
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('parseServerConfig', () => {
  // Silence console.log during tests
  beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('should parse mcpServers structure', () => {
    const input = `{
      "mcpServers": {
        "test-server": {
          "command": "python",
          "args": ["server.py", "--port", "8000"],
          "disabled": false,
          "autoApprove": ["test"]
        }
      }
    }`;

    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;

    expect(config).toEqual({
      name: 'test-server',
      command: 'python',
      args: ['server.py', '--port', '8000'],
      disabled: false,
      autoApprove: ['test'],
      env: {},
      _buildCommand: undefined,
      _installCommand: undefined
    });
    expect(result.message?.type).toBe('success');
  });

  test('should parse direct structure', () => {
    const input = `{
      "test-server": {
        "command": "node",
        "args": ["index.js"],
        "disabled": false,
        "autoApprove": []
      }
    }`;

    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;
    expect(config.command).toBe('node');
    expect(result.message?.type).toBe('success');
  });

  test('should extract environment variables', () => {
    const input = `
      PORT=3000
      API_KEY='secret123'
      DEBUG=true # with comment
      
      {
        "command": "server",
        "args": []
      }
    `;

    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;
    expect(config.env).toEqual({
      PORT: '3000',
      API_KEY: 'secret123',
      DEBUG: 'true'
    });
  });

  test('should extract build and install commands from code blocks', () => {
    const input = `
      \`\`\`bash
      npm install
      npm run build
      \`\`\`
      
      {
        "command": "start",
        "args": []
      }
    `;

    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;
    expect(config._buildCommand).toBe('npm run build');
    expect(config._installCommand).toBe('npm install');
  });

  test('should handle markdown escaping', () => {
    const input = '\\`\\`\\`bash\nnpm start\n\\`\\`\\`';
    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;
    expect(config.command).toBe('npm start');
  });

  test('should process path-like arguments', () => {
    const input = `{
      "command": "python",
      "args": ["/path/to/script.py", "PATH_TO/config.json"]
    }`;

    const result = parseServerConfig(input);
    const config = result.config as TestMCPConfig;
    expect(config.args).toEqual(['script.py', 'config.json']);
  });

  test('should handle invalid input gracefully', () => {
    const result = parseServerConfig('invalid json');
    expect(result.message?.type).toBe('error');
    expect(result.config).toEqual({
      name: '',
      command: '',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      _buildCommand: undefined,
      _installCommand: undefined
    });
  });

  test('should handle empty input', () => {
    const result = parseServerConfig('');
    expect(result.message?.type).toBe('error');
    expect(result.config).toEqual({
      name: '',
      command: '',
      args: [],
      env: {},
      disabled: false,
      autoApprove: [],
      _buildCommand: undefined,
      _installCommand: undefined
    });
  });
}); 