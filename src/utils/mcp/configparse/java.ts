'use client';

import { ConfigParseOptions, ConfigParseResult } from './types';
import { checkFileExists, readFile } from './utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/configparse/java');

/**
 * Parse Java repository configuration
 */
export async function parseJavaConfig(options: ConfigParseOptions): Promise<ConfigParseResult> {
  const { repoPath, repoName } = options;
  
  log.debug(`Parsing Java configuration for ${repoPath}`);
  
  // Check for Java project files
  const pomXmlResult = await checkFileExists(repoPath, 'pom.xml', true);
  const gradleResult = await checkFileExists(repoPath, 'build.gradle', true);
  const gradleWrapperResult = await checkFileExists(repoPath, 'gradlew');
  const mavenWrapperResult = await checkFileExists(repoPath, 'mvnw');
  
  if (!pomXmlResult.exists && !gradleResult.exists) {
    log.debug(`No Java project files found in ${repoPath}`);
    return {
      detected: false,
      language: 'java',
      message: {
        type: 'warning',
        text: 'No Java project files found in the repository.'
      }
    };
  }
  
  // Determine if it's a Maven or Gradle project
  const isMaven = pomXmlResult.exists;
  const isGradle = gradleResult.exists;
  const hasGradleWrapper = gradleWrapperResult.exists;
  const hasMavenWrapper = mavenWrapperResult.exists;
  
  // Determine install and build commands
  const installCommand = determineInstallCommand(isMaven, isGradle, hasMavenWrapper, hasGradleWrapper);
  const buildCommand = determineBuildCommand(isMaven, isGradle, hasMavenWrapper, hasGradleWrapper);
  
  // Determine run command and args
  const { runCommand, args } = await determineRunCommand(
    repoPath,
    isMaven,
    isGradle,
    pomXmlResult.content,
    gradleResult.content
  );
  
  // Check for .env.example
  const envVars = await extractEnvVars(repoPath);
  
  return {
    detected: true,
    language: 'java',
    installCommand,
    buildCommand,
    runCommand,
    args,
    env: envVars,
    message: {
      type: 'success',
      text: `Java configuration detected successfully.`
    },
    config: {
      name: repoName,
      transport: 'stdio',
      command: runCommand,
      args,
      env: envVars,
      _buildCommand: buildCommand,
      _installCommand: installCommand
    }
  };
}

/**
 * Determine the appropriate install command based on project type
 */
function determineInstallCommand(
  isMaven: boolean,
  isGradle: boolean,
  hasMavenWrapper: boolean,
  hasGradleWrapper: boolean
): string {
  if (isMaven) {
    return hasMavenWrapper ? './mvnw install -DskipTests' : 'mvn install -DskipTests';
  } else if (isGradle) {
    return hasGradleWrapper ? './gradlew dependencies' : 'gradle dependencies';
  }
  
  // Default install command
  return '';
}

/**
 * Determine the appropriate build command based on project type
 */
function determineBuildCommand(
  isMaven: boolean,
  isGradle: boolean,
  hasMavenWrapper: boolean,
  hasGradleWrapper: boolean
): string {
  if (isMaven) {
    return hasMavenWrapper ? './mvnw package -DskipTests' : 'mvn package -DskipTests';
  } else if (isGradle) {
    return hasGradleWrapper ? './gradlew build' : 'gradle build';
  }
  
  // Default build command
  return '';
}

/**
 * Determine the appropriate run command and arguments
 * Always use direct java command instead of scripts
 */
async function determineRunCommand(
  repoPath: string,
  isMaven: boolean,
  isGradle: boolean,
  pomXmlContent?: string,
  gradleContent?: string
): Promise<{ runCommand: string; args: string[] }> {
  // Always use java directly
  const runCommand = 'java';
  const args: string[] = [];
  
  // Add -jar argument
  args.push('-jar');
  
  // Try to find the actual JAR file
  if (isMaven) {
    // For Maven projects, check target directory
    try {
      // Look for artifactId to guess the JAR name
      if (pomXmlContent) {
        const artifactIdMatch = pomXmlContent.match(/<artifactId>([^<]+)<\/artifactId>/);
        if (artifactIdMatch) {
          const artifactId = artifactIdMatch[1];
          // Check if the specific JAR exists
          const specificJarPath = `target/${artifactId}*.jar`;
          args.push(specificJarPath);
          return { runCommand, args };
        }
      }
      
      // Default to any JAR in target directory
      args.push('target/*.jar');
      return { runCommand, args };
    } catch (error) {
      log.error('Error determining Maven JAR path:', error);
    }
  } else if (isGradle) {
    // For Gradle projects, check build/libs directory
    try {
      // Check for shadow JAR first (most common for standalone apps)
      const shadowJarPath = 'build/libs/*-all.jar';
      const shadowJarExists = await checkFileExists(repoPath, shadowJarPath);
      
      if (shadowJarExists.exists) {
        args.push(shadowJarPath);
        return { runCommand, args };
      }
      
      // Check for fat JAR
      const fatJarPath = 'build/libs/*-fat.jar';
      const fatJarExists = await checkFileExists(repoPath, fatJarPath);
      
      if (fatJarExists.exists) {
        args.push(fatJarPath);
        return { runCommand, args };
      }
      
      // Default to any JAR in build/libs directory
      args.push('build/libs/*.jar');
      return { runCommand, args };
    } catch (error) {
      log.error('Error determining Gradle JAR path:', error);
    }
  }
  
  // If we couldn't determine a specific path, use a default
  if (args.length === 1) { // Only -jar is in args
    // Try to find any JAR file in common locations
    const jarLocations = [
      'target/*.jar',
      'build/libs/*.jar',
      'out/artifacts/*/*.jar'
    ];
    
    for (const jarLocation of jarLocations) {
      const jarExists = await checkFileExists(repoPath, jarLocation);
      if (jarExists.exists) {
        args.push(jarLocation);
        return { runCommand, args };
      }
    }
    
    // Default to target/*.jar if nothing else found
    args.push('target/*.jar');
  }
  
  return { runCommand, args };
}

/**
 * Extract environment variables from .env.example if it exists
 */
async function extractEnvVars(repoPath: string): Promise<Record<string, string>> {
  const envExample = await readFile(repoPath, '.env.example');
  
  if (!envExample) {
    return {};
  }
  
  const envVars: Record<string, string> = {};
  
  // Parse .env.example line by line
  const lines = envExample.split('\n');
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip comments and empty lines
    if (trimmedLine.startsWith('#') || trimmedLine === '') {
      continue;
    }
    
    // Parse KEY=value format
    const match = trimmedLine.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      
      // Remove quotes if present
      const cleanValue = value.replace(/^["'](.*)["']$/, '$1');
      
      envVars[key] = cleanValue;
    }
  }
  
  return envVars;
}
