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
import { parseTypeScriptConfig } from '../typescript';

describe('parseTypeScriptConfig', () => {
  const mockOptions: ConfigParseOptions = {
    repoPath: '/test/repo',
    repoName: 'test-repo'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('package.json detection', () => {
    it('should return not detected when package.json is missing', async () => {
      // Mock package.json not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(false);
      expect(result.language).toBe('typescript');
      expect(result.message?.type).toBe('warning');
      expect(mockCheckFileExists).toHaveBeenCalledWith('/test/repo', 'package.json', true);
    });

    it('should handle invalid JSON in package.json', async () => {
      // Mock package.json existing but with invalid JSON
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'not valid json' 
      });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(false);
      expect(result.language).toBe('typescript');
      expect(result.message?.type).toBe('error');
      expect(result.message?.text).toContain('Error parsing package.json');
    });
  });

  describe('package manager detection', () => {
    it('should detect npm as the default package manager', async () => {
      // Mock package.json existing with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({}) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('npm install');
    });

    it('should detect yarn as the package manager', async () => {
      // Mock package.json with yarn as package manager
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          packageManager: 'yarn@3.0.0'
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('yarn install');
    });

    it('should detect pnpm as the package manager', async () => {
      // Mock package.json with pnpm as package manager
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          packageManager: 'pnpm@6.0.0'
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('pnpm install');
    });
  });

  describe('build command detection', () => {
    it('should detect build command from package.json scripts.build', async () => {
      // Mock package.json with build script
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.buildCommand).toBe('npm run build');
    });

    it('should detect build command from package.json scripts.compile', async () => {
      // Mock package.json with compile script
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            compile: 'tsc'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.buildCommand).toBe('npm run compile');
    });

    it('should detect build command from package.json scripts.dist', async () => {
      // Mock package.json with dist script
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            dist: 'tsc'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.buildCommand).toBe('npm run dist');
    });

    it('should detect build command from package.json scripts.prepare if it includes build', async () => {
      // Mock package.json with prepare script containing build
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            prepare: 'husky install && npm run build'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.buildCommand).toBe('npm run prepare');
    });
    
    it('should set empty build command when no relevant scripts exist', async () => {
      // Mock package.json with no build-related scripts
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            test: 'jest'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.buildCommand).toBe('');
    });
  });

  describe('entry point detection from build script', () => {
    it('should extract output directory from build script with --outDir flag', async () => {
      // Mock package.json with build script containing outDir
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc --outDir custom-dist'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - no files exist
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['custom-dist/index.js']);
    });

    it('should extract output directory from build script with webpack output', async () => {
      // Mock package.json with webpack build script
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'webpack --output public'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - no files exist
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['public/index.js']);
    });

    it('should detect build directory from build script', async () => {
      // Mock package.json with build script containing build/ reference
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc && cp -r src/assets build/'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - no files exist
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['build/index.js']);
    });
  });

  describe('entry point detection from start script', () => {
    it('should extract entry point from start script with direct node command', async () => {
      // Mock package.json with start script using node directly
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            start: 'node ./dist/server.js'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['./dist/server.js']);
    });

    it('should convert ts-node entry point to js file in output directory', async () => {
      // Mock package.json with start script using ts-node
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc --outDir lib',
            start: 'ts-node ./src/index.ts'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['./src/index.ts']);
    });
  });

  describe('entry point detection from filesystem', () => {
    it('should detect entry point from output directory index file', async () => {
      // Mock package.json with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - dist/index.js exists
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'dist/index.js') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/index.js']);
    });

    it('should check for common entry points when output directory doesn\'t have an index file', async () => {
      // Mock package.json with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            build: 'tsc'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - lib/index.js exists, but not dist/index.js
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'dist/index.js') {
          return Promise.resolve({ exists: false });
        } else if (filePath === 'lib/index.js') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/index.js']);
    });
  });

  describe('run arguments detection', () => {
    it('should use main from package.json', async () => {
      // Mock package.json with main field
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          main: 'dist/index.js'
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/index.js']);
      expect(result.runCommand).toBe('node');
    });

    it('should detect entry point from start script using node', async () => {
      // Mock package.json with start script using node
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            start: 'node dist/server.js'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/server.js']);
      expect(result.runCommand).toBe('node');
    });

    it('should detect entry point from start script using ts-node', async () => {
      // Mock package.json with start script using ts-node
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          scripts: {
            start: 'ts-node src/server.ts'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['src/server.ts']);
      expect(result.runCommand).toBe('node');
    });
    
    it('should detect existing entry points in the filesystem', async () => {
      // Mock package.json with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({}) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - dist/index.js exists
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'dist/index.js') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/index.js']);
      expect(result.runCommand).toBe('node');
    });

    it('should use default entry point when nothing is found', async () => {
      // Mock package.json with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({}) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs - no files exist
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['dist/index.js']);
      expect(result.runCommand).toBe('node');
    });
  });

  describe('environment variables', () => {
    it('should extract environment variables from .env.example', async () => {
      // Mock package.json existing with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({}) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example content
      mockReadFile.mockResolvedValueOnce(`
        # This is a comment
        API_KEY=your-api-key
        PORT=3000
        DEBUG=true
      `);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({
        API_KEY: 'your-api-key',
        PORT: '3000',
        DEBUG: 'true'
      });
    });

    it('should handle missing .env.example', async () => {
      // Mock package.json existing with minimal content
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({}) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example not found
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({});
    });
  });

  describe('final configuration', () => {
    it('should return a complete configuration', async () => {
      // Mock package.json with all fields
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: JSON.stringify({
          packageManager: 'yarn@3.0.0',
          main: 'dist/server.js',
          scripts: {
            build: 'tsc',
            start: 'node dist/server.js'
          }
        }) 
      });
      // Mock tsconfig.json check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true });
      // Mock file checks in determineArgs
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example content
      mockReadFile.mockResolvedValueOnce(`
        API_KEY=your-api-key
        PORT=3000
      `);
      
      const result = await parseTypeScriptConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('typescript');
      expect(result.installCommand).toBe('yarn install');
      expect(result.buildCommand).toBe('npm run build');
      expect(result.runCommand).toBe('node');
      expect(result.args).toEqual(['dist/server.js']);
      expect(result.env).toEqual({
        API_KEY: 'your-api-key',
        PORT: '3000'
      });
      expect(result.message?.type).toBe('success');
      expect(result.config).toEqual({
        name: 'test-repo',
        transport: 'stdio',
        command: 'node',
        args: ['dist/server.js'],
        env: {
          API_KEY: 'your-api-key',
          PORT: '3000'
        },
        _buildCommand: 'npm run build',
        _installCommand: 'yarn install'
      });
    });
  });
}); 