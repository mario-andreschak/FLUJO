/**
 * @jest-environment node
 */
import { jest } from '@jest/globals';
import { ConfigParseOptions, FileExistsResult } from '../types';

// Mock the logger module
jest.mock('@/utils/logger', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return {
    createLogger: jest.fn(() => mockLogger)
  };
});

// Mock the utils module
const mockCheckFileExists = jest.fn<(path: string, file: string, optional?: boolean) => Promise<FileExistsResult>>();
const mockReadFile = jest.fn<(path: string, file: string) => Promise<string | null>>();

jest.mock('../utils', () => ({
  checkFileExists: mockCheckFileExists,
  readFile: mockReadFile
}));

// Import after mocking
import { parsePythonConfig } from '../python';

describe('parsePythonConfig', () => {
  const mockOptions: ConfigParseOptions = {
    repoPath: '/test/repo',
    repoName: 'test-repo'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('project detection', () => {
    it('should return not detected when no Python project files exist', async () => {
      // Mock requirements.txt, pyproject.toml, and setup.py not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(false);
      expect(result.language).toBe('python');
      expect(result.message?.type).toBe('warning');
    });

    it('should detect Python project with requirements.txt', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock entry point checks in determineRunCommand (none found)
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('python');
      expect(result.installCommand).toBe('uv pip install -r requirements.txt --system');
      expect(result.buildCommand).toBe(''); // Python doesn't need build step
      expect(result.runCommand).toBe('python');
    });

    it('should detect Python project with pyproject.toml', async () => {
      // Mock requirements.txt not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // requirements.txt
      // Mock pyproject.toml existing
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: '[project]\nname = "test-app"\n' 
      }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock entry point checks in determineRunCommand (none found)
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('python');
      expect(result.installCommand).toBe('uv pip install -e . --system');
      expect(result.args).toEqual(['-m', 'test_app']);
    });

    it('should detect Python project with setup.py', async () => {
      // Mock requirements.txt and pyproject.toml not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      // Mock setup.py existing
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'setup(\n    name="my-package",\n    version="0.1.0",\n)' 
      }); // setup.py
      // Mock entry point checks in determineRunCommand (none found)
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('python');
      expect(result.installCommand).toBe('pip install -e .');
      expect(result.args).toEqual(['-m', 'my_package']);
    });
  });

  describe('entry point detection', () => {
    it('should detect main.py entry point', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock main.py existing
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'main.py') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['main.py']);
    });

    it('should detect app.py entry point', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock main.py not existing but app.py existing
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'app.py') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['app.py']);
    });

    it('should detect server.py entry point', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock main.py and app.py not existing but server.py existing
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'server.py') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['server.py']);
    });

    it('should detect entry point from poetry scripts in pyproject.toml', async () => {
      // Mock requirements.txt not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // requirements.txt
      // Mock pyproject.toml with poetry scripts
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: `
          [tool.poetry]
          name = "my-app"
          version = "0.1.0"
          
          [tool.poetry.scripts]
          start = "my_app.cli:main"
          
          [build-system]
          requires = ["poetry-core>=1.0.0"]
          build-backend = "poetry.core.masonry.api"
        ` 
      }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock no entry point files found
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-m', 'my_app.cli:main']);
    });
  });

  describe('environment variables', () => {
    it('should extract environment variables from .env.example', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock entry point checks in determineRunCommand (none found)
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        # Config for Python app
        FLASK_ENV=development
        PORT=5000
        DATABASE_URL="postgresql://localhost/mydb"
      `);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({
        FLASK_ENV: 'development',
        PORT: '5000',
        DATABASE_URL: 'postgresql://localhost/mydb'
      });
    });

    it('should handle missing .env.example', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock entry point checks in determineRunCommand (none found)
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example not found
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({});
    });
  });

  describe('final configuration', () => {
    it('should return a complete configuration', async () => {
      // Mock requirements.txt existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // requirements.txt
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pyproject.toml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // setup.py
      // Mock app.py existing
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'app.py') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        FLASK_ENV=development
        PORT=5000
      `);
      
      const result = await parsePythonConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('python');
      expect(result.installCommand).toBe('uv pip install -r requirements.txt --system');
      expect(result.buildCommand).toBe('');
      expect(result.runCommand).toBe('python');
      expect(result.args).toEqual(['app.py']);
      expect(result.env).toEqual({
        FLASK_ENV: 'development',
        PORT: '5000'
      });
      expect(result.message?.type).toBe('success');
      expect(result.config).toEqual({
        name: 'test-repo',
        transport: 'stdio',
        command: 'python',
        args: ['app.py'],
        env: {
          FLASK_ENV: 'development',
          PORT: '5000'
        },
        _buildCommand: '',
        _installCommand: 'uv pip install -r requirements.txt --system'
      });
    });
  });
}); 