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
import { parseJavaConfig } from '../java';

describe('parseJavaConfig', () => {
  const mockOptions: ConfigParseOptions = {
    repoPath: '/test/repo',
    repoName: 'test-repo'
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('project detection', () => {
    it('should return not detected when no Java project files exist', async () => {
      // Mock pom.xml and build.gradle not existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(false);
      expect(result.language).toBe('java');
      expect(result.message?.type).toBe('warning');
    });

    it('should detect Maven project', async () => {
      // Mock pom.xml existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: '<project></project>' }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('java');
      expect(result.installCommand).toBe('mvn install -DskipTests');
      expect(result.buildCommand).toBe('mvn package -DskipTests');
      expect(result.runCommand).toBe('java');
    });

    it('should detect Gradle project', async () => {
      // Mock build.gradle existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'apply plugin: "java"' }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('java');
      expect(result.installCommand).toBe('gradle dependencies');
      expect(result.buildCommand).toBe('gradle build');
      expect(result.runCommand).toBe('java');
    });
  });

  describe('wrapper detection', () => {
    it('should detect Maven wrapper', async () => {
      // Mock pom.xml and mvnw existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: '<project></project>' }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('./mvnw install -DskipTests');
      expect(result.buildCommand).toBe('./mvnw package -DskipTests');
    });

    it('should detect Gradle wrapper', async () => {
      // Mock build.gradle and gradlew existing
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'apply plugin: "java"' }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.installCommand).toBe('./gradlew dependencies');
      expect(result.buildCommand).toBe('./gradlew build');
    });
  });

  describe('JAR detection', () => {
    it('should detect Maven JAR with artifactId', async () => {
      // Mock pom.xml with artifactId
      const pomXmlContent = `
        <project>
          <groupId>com.example</groupId>
          <artifactId>test-app</artifactId>
          <version>1.0.0</version>
        </project>
      `;
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: pomXmlContent }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'target/test-app*.jar']);
    });

    it('should detect Gradle shadow JAR', async () => {
      // Mock build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'apply plugin: "java"' }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock shadow JAR exists
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-all.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*-all.jar']);
    });

    it('should detect Gradle fat JAR', async () => {
      // Mock build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'apply plugin: "java"' }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock shadow JAR doesn't exist but fat JAR does
      mockCheckFileExists.mockImplementation((repoPath: string, filePath: string) => {
        if (filePath === 'build/libs/*-fat.jar') {
          return Promise.resolve({ exists: true });
        }
        return Promise.resolve({ exists: false });
      });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*-fat.jar']);
    });

    it('should default to any JAR in build/libs for Gradle', async () => {
      // Mock build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: 'apply plugin: "java"' }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock no specific JARs found
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.args).toEqual(['-jar', 'build/libs/*.jar']);
    });
  });

  describe('environment variables', () => {
    it('should extract environment variables from .env.example', async () => {
      // Mock pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: '<project></project>' }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        # Config for Java app
        SERVER_PORT=8080
        DB_URL=jdbc:postgresql://localhost:5432/mydb
        API_KEY=sample-key
      `);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({
        SERVER_PORT: '8080',
        DB_URL: 'jdbc:postgresql://localhost:5432/mydb',
        API_KEY: 'sample-key'
      });
    });

    it('should handle missing .env.example', async () => {
      // Mock pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: '<project></project>' }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example not found
      mockReadFile.mockResolvedValueOnce(null);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.env).toEqual({});
    });
  });

  describe('final configuration', () => {
    it('should return a complete configuration', async () => {
      // Mock pom.xml with artifactId
      const pomXmlContent = `
        <project>
          <groupId>com.example</groupId>
          <artifactId>test-app</artifactId>
          <version>1.0.0</version>
        </project>
      `;
      mockCheckFileExists.mockResolvedValueOnce({ exists: true, content: pomXmlContent }); // pom.xml
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // build.gradle
      mockCheckFileExists.mockResolvedValueOnce({ exists: false }); // gradlew
      mockCheckFileExists.mockResolvedValueOnce({ exists: true }); // mvnw
      // Mock JAR file checks in determineRunCommand
      mockCheckFileExists.mockResolvedValue({ exists: false });
      // Mock .env.example with content
      mockReadFile.mockResolvedValueOnce(`
        SERVER_PORT=8080
        DB_URL=jdbc:postgresql://localhost:5432/mydb
      `);
      
      const result = await parseJavaConfig(mockOptions);
      
      expect(result.detected).toBe(true);
      expect(result.language).toBe('java');
      expect(result.installCommand).toBe('./mvnw install -DskipTests');
      expect(result.buildCommand).toBe('./mvnw package -DskipTests');
      expect(result.runCommand).toBe('java');
      expect(result.args).toEqual(['-jar', 'target/test-app*.jar']);
      expect(result.env).toEqual({
        SERVER_PORT: '8080',
        DB_URL: 'jdbc:postgresql://localhost:5432/mydb'
      });
      expect(result.message?.type).toBe('success');
      expect(result.config).toEqual({
        name: 'test-repo',
        transport: 'stdio',
        command: 'java',
        args: ['-jar', 'target/test-app*.jar'],
        env: {
          SERVER_PORT: '8080',
          DB_URL: 'jdbc:postgresql://localhost:5432/mydb'
        },
        _buildCommand: './mvnw package -DskipTests',
        _installCommand: './mvnw install -DskipTests'
      });
    });
  });
}); 