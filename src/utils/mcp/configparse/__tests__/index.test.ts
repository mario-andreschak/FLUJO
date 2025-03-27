import { parseRepositoryConfig } from '../index';
import { parseTypeScriptConfig } from '../typescript';
import { parsePythonConfig } from '../python';
import { parseJavaConfig } from '../java';
import { parseKotlinConfig } from '../kotlin';
import { parseConfigFromReadme } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configUtils';
import { ConfigParseOptions } from '../types';

// Mock all parsers
jest.mock('../typescript', () => ({
  parseTypeScriptConfig: jest.fn().mockResolvedValue({ detected: false })
}));
jest.mock('../python', () => ({
  parsePythonConfig: jest.fn().mockResolvedValue({ detected: false })
}));
jest.mock('../java', () => ({
  parseJavaConfig: jest.fn().mockResolvedValue({ detected: false })
}));
jest.mock('../kotlin', () => ({
  parseKotlinConfig: jest.fn().mockResolvedValue({ detected: false })
}));

// Mock logger
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })
}));

// Mock fetch properly
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock configUtils
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/utils/configUtils', () => ({
  parseConfigFromReadme: jest.fn().mockResolvedValue({
    detected: true,
    config: {
      name: 'test-repo',
      transport: 'stdio',
      command: 'test-command',
      args: ['--test'],
      env: {},
      disabled: false,
      autoApprove: []
    },
    message: { type: 'success', text: 'Config found in README' }
  })
}));

describe('parseRepositoryConfig', () => {
  const mockOptions: ConfigParseOptions = {
    repoPath: '/test/repo',
    repoName: 'test-repo'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should detect TypeScript configuration', async () => {
    const mockTsConfig = {
      detected: true,
      language: 'typescript' as const,
      config: { name: 'test' }
    };
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce(mockTsConfig);

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result).toEqual(mockTsConfig);
    expect(parseTypeScriptConfig).toHaveBeenCalledWith(mockOptions);
    expect(parsePythonConfig).not.toHaveBeenCalled();
  });

  test('should try Python if TypeScript not detected', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    const mockPythonConfig = {
      detected: true,
      language: 'python' as const,
      config: { name: 'test' }
    };
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce(mockPythonConfig);

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result).toEqual(mockPythonConfig);
    expect(parsePythonConfig).toHaveBeenCalledWith(mockOptions);
  });

  test('should try Java if Python not detected', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    const mockJavaConfig = {
      detected: true,
      language: 'java' as const,
      config: { name: 'test' }
    };
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce(mockJavaConfig);

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result).toEqual(mockJavaConfig);
    expect(parseJavaConfig).toHaveBeenCalledWith(mockOptions);
  });

  test('should try Kotlin if Java not detected', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    const mockKotlinConfig = {
      detected: true,
      language: 'kotlin' as const,
      config: { name: 'test' }
    };
    (parseKotlinConfig as jest.Mock).mockResolvedValueOnce(mockKotlinConfig);

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result).toEqual(mockKotlinConfig);
    expect(parseKotlinConfig).toHaveBeenCalledWith(mockOptions);
  });

  test('should try README if no language detected', async () => {
    // Mock README fetch response
    mockFetch.mockImplementationOnce(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: '# Test\ncommand: test-command'
        })
      })
    );

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(true);
    expect(result.language).toBe('unknown');
    expect(result.config).toEqual(expect.objectContaining({
      name: 'test-repo',
      transport: 'stdio'
    }));
  });

  test('should return default config if nothing detected', async () => {
    // Mock README fetch to fail
    mockFetch.mockImplementationOnce(() => 
      Promise.resolve({
        ok: false
      })
    );

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(false);
    expect(result.language).toBe('unknown');
    expect(result.message?.type).toBe('error');
    expect(result.config).toEqual({
      name: mockOptions.repoName,
      transport: 'stdio',
      command: '',
      args: [],
      env: {},
      _buildCommand: '',
      _installCommand: ''
    });
  });

  test('should handle empty README content', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseKotlinConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    
    // Mock README fetch with empty content
    mockFetch.mockImplementationOnce(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: ''
        })
      })
    );

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(false);
    expect(result.language).toBe('unknown');
    expect(result.message?.type).toBe('error');
    expect(result.message?.text).toBe('Could not detect repository configuration. Please configure manually.');
  });

  test('should handle parseConfigFromReadme returning empty config', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseKotlinConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    
    // Mock README fetch with valid content
    mockFetch.mockImplementationOnce(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: '# Test\nThis is a test readme without config'
        })
      })
    );
    
    // Mock parseConfigFromReadme to return empty config
    (parseConfigFromReadme as jest.Mock).mockResolvedValueOnce({
      config: {
        name: 'test-repo',
        transport: 'stdio',
        command: '',
        args: [],
        env: {}
      },
      message: {
        type: 'warning',
        text: 'No configuration found in README.'
      }
    });

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(false);
    expect(result.language).toBe('unknown');
    expect(result.message?.type).toBe('error');
    expect(result.message?.text).toBe('Could not detect repository configuration. Please configure manually.');
  });

  test('should handle README with only build/install commands', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseKotlinConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    
    // Mock README fetch with content containing only build command
    mockFetch.mockImplementationOnce(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          content: '# Test\nbuild_command: npm run build'
        })
      })
    );
    
    // Mock parseConfigFromReadme to return config with build command
    (parseConfigFromReadme as jest.Mock).mockResolvedValueOnce({
      config: {
        name: 'test-repo',
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        _buildCommand: 'npm run build',
        _installCommand: ''
      },
      message: {
        type: 'success',
        text: 'Configuration extracted from README.'
      }
    });

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(true);
    expect(result.language).toBe('unknown');
    expect(result.buildCommand).toBe('npm run build');
    expect(result.installCommand).toBe('');
    expect(result.message?.type).toBe('success');
  });

  test('should handle HTTP error during README fetch', async () => {
    (parseTypeScriptConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parsePythonConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseJavaConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    (parseKotlinConfig as jest.Mock).mockResolvedValueOnce({ detected: false });
    
    // Mock README fetch to throw network error
    mockFetch.mockImplementationOnce(() => {
      throw new Error('Network error');
    });

    const result = await parseRepositoryConfig(mockOptions);
    
    expect(result.detected).toBe(false);
    expect(result.language).toBe('unknown');
    expect(result.message?.type).toBe('error');
    expect(result.message?.text).toBe('Could not detect repository configuration. Please configure manually.');
  });
}); 