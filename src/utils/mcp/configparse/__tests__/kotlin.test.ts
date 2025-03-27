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
import { parseKotlinConfig } from '../kotlin';

describe('parseKotlinConfig', () => {
  const mockOptions: ConfigParseOptions = {
    repoPath: '/test/repo',
    repoName: 'test-repo'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('project detection', () => {
    it('should return not detected when no Kotlin project files exist', async () => {
      // Mock build.gradle.kts and build.gradle not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock no Kotlin files found in any location
      mockCheckFileExists.mockResolvedValue({ exists: false });
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(false);
      expect(result.language).toBe('kotlin');
      expect(result.message?.type).toBe('warning');
    });

    it('should detect Kotlin project with build.gradle.kts', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // No need to check for Kotlin files since build.gradle.kts is found
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('kotlin');
      expect(result.installCommand).toBe('gradle dependencies');
      expect(result.buildCommand).toBe('gradle build');
      expect(result.runCommand).toBe('java');
    });

    it('should detect Kotlin project with build.gradle containing Kotlin plugin', async () => {
      // Mock build.gradle.kts not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle.kts
      // Mock build.gradle containing Kotlin plugin
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'apply plugin: "org.jetbrains.kotlin.jvm"' 
      }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock Kotlin files check
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // src/main/kotlin
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // src/test/kotlin
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // src
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('kotlin');
      expect(result.installCommand).toBe('gradle dependencies');
      expect(result.buildCommand).toBe('gradle build');
    });

    it('should detect Kotlin project by finding Kotlin source files', async () => {
      // Mock build.gradle.kts not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle.kts
      // Mock build.gradle without Kotlin plugin
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'apply plugin: "java"' 
      }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock Kotlin files check - src/main/kotlin exists
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // src/main/kotlin
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('kotlin');
    });
  });

  describe('wrapper detection', () => {
    it('should detect Gradle wrapper', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // gradlew
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('./gradlew dependencies');
      expect(result.buildCommand).toBe('./gradlew build');
    });
  });

  describe('JAR detection', () => {
    it('should detect shadow JAR', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock shadow JAR exists
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-all.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*-all.jar']);
    });

    it('should detect fat JAR', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock shadow JAR doesn't exist but fat JAR does
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-fat.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*-fat.jar']);
    });

    it('should detect JAR with dependencies', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock shadow JAR and fat JAR don't exist but dep JAR does
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-with-dependencies.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*-with-dependencies.jar']);
    });

    it('should detect JAR based on mainClass from build.gradle.kts', async () => {
      // Mock build.gradle.kts with mainClass
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'application { mainClass.set("com.example.MainKt") }' 
      }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock specific JAR types don't exist, but main class JAR does
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*main*.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*.jar']);
    });

    it('should detect JAR based on mainClassName from build.gradle', async () => {
      // Mock build.gradle.kts not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle.kts
      // Mock build.gradle with mainClassName
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'mainClassName = "com.example.ApplicationKt"' 
      }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock Kotlin files check
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // src/main/kotlin
      // Mock specific JAR types don't exist, but application JAR does
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*application*.jar') {
          return Promise.resolve({ exists: true });
        }
        if (filePath === 'src/main/kotlin') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*.jar']);
    });

    it('should default to any JAR in build/libs', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock no specific JARs found
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*.jar']);
    });
  });

  describe('environment variables', () => {
    it('should extract environment variables from .env.example', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        # Config for Kotlin app
        SERVER_PORT=8080
        DB_URL=jdbc:postgresql://localhost:5432/mydb
        API_KEY=sample-key
      `);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({
        SERVER_PORT: '8080',
        DB_URL: 'jdbc:postgresql://localhost:5432/mydb',
        API_KEY: 'sample-key'
      });
    });

    it('should handle missing .env.example', async () => {
      // Mock build.gradle.kts existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'kotlin {}' }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example not found
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({});
    });
  });

  describe('final configuration', () => {
    it('should return a complete configuration', async () => {
      // Mock build.gradle.kts with mainClass
      mockCheckFileExists.mockResolvedValueOnce({ 
        exists: true, 
        content: 'application { mainClass.set("com.example.MainKt") }' 
      }); // build.gradle.kts
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // gradlew
      // Mock shadow JAR exists
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-all.jar') {
          return Promise.resolve({ exists: true });
        }
        if (filePath === 'gradlew') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        SERVER_PORT=8080
        DB_URL=jdbc:postgresql://localhost:5432/mydb
      `);
      
      const result = await parseKotlinConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('kotlin');
      expect(result.installCommand).toBe('./gradlew dependencies');
      expect(result.buildCommand).toBe('./gradlew build');
      expect(result.runCommand).toBe('java');
      expect(result.args).toEqual(['-jar', 'build/libs/*-all.jar']);
      expect(result.env).toEqual({
        SERVER_PORT: '8080',
        DB_URL: 'jdbc:postgresql://localhost:5432/mydb'
      });
      expect(result.message?.type).toBe('success');
      expect(result.config).toEqual({
        name: 'test-repo',
        transport: 'stdio',
        command: 'java',
        args: ['-jar', 'build/libs/*-all.jar'],
        env: {
          SERVER_PORT: '8080',
          DB_URL: 'jdbc:postgresql://localhost:5432/mydb'
        },
        _buildCommand: './gradlew build',
        _installCommand: './gradlew dependencies'
      });
    });
  });
}); 