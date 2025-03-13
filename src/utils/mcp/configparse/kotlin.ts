'use client';

import { ConfigParseOptions, ConfigParseResult } from './types';
import { checkFileExists, readFile } from './utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/configparse/kotlin');

/**
 * Parse Kotlin repository configuration
 */
export async function parseKotlinConfig(options: ConfigParseOptions): Promise<ConfigParseResult> {
  const { repoPath, repoName } = options;
  
  log.debug(`Parsing Kotlin configuration for ${repoPath}`);
  
  // Check for Kotlin project files
  const gradleKtsResult = await checkFileExists(repoPath, 'build.gradle.kts', true);
  const gradleResult = await checkFileExists(repoPath, 'build.gradle', true);
  const gradleWrapperResult = await checkFileExists(repoPath, 'gradlew');
  const kotlinFiles = await hasKotlinFiles(repoPath);
  
  // If no Kotlin-specific files found, but has build.gradle, it might be a Java project with Kotlin
  if (!gradleKtsResult.exists && !kotlinFiles) {
    if (gradleResult.exists) {
      // Check if build.gradle contains Kotlin references
      const hasKotlinPlugin = gradleResult.content && 
        (gradleResult.content.includes('kotlin') || 
         gradleResult.content.includes('org.jetbrains.kotlin'));
      
      if (!hasKotlinPlugin) {
        log.debug(`No Kotlin project files found in ${repoPath}`);
        return {
          detected: false,
          language: 'kotlin',
          message: {
            type: 'warning',
            text: 'No Kotlin project files found in the repository.'
          }
        };
      }
    } else {
      log.debug(`No Kotlin project files found in ${repoPath}`);
      return {
        detected: false,
        language: 'kotlin',
        message: {
          type: 'warning',
          text: 'No Kotlin project files found in the repository.'
        }
      };
    }
  }
  
  // Determine if it's a Gradle KTS or regular Gradle project
  const isGradleKts = gradleKtsResult.exists;
  const isGradle = gradleResult.exists;
  const hasGradleWrapper = gradleWrapperResult.exists;
  
  // Determine install and build commands
  const installCommand = determineInstallCommand(isGradleKts, isGradle, hasGradleWrapper);
  const buildCommand = determineBuildCommand(isGradleKts, isGradle, hasGradleWrapper);
  
  // Determine run command and args
  const { runCommand, args } = await determineRunCommand(
    repoPath,
    isGradleKts,
    isGradle,
    gradleKtsResult.content,
    gradleResult.content
  );
  
  // Check for .env.example
  const envVars = await extractEnvVars(repoPath);
  
  return {
    detected: true,
    language: 'kotlin',
    installCommand,
    buildCommand,
    runCommand,
    args,
    env: envVars,
    message: {
      type: 'success',
      text: `Kotlin configuration detected successfully.`
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
 * Check if the repository has Kotlin files
 */
async function hasKotlinFiles(repoPath: string): Promise<boolean> {
  // Check for Kotlin files in common locations
  const kotlinLocations = [
    'src/main/kotlin',
    'src/test/kotlin',
    'src'
  ];
  
  for (const location of kotlinLocations) {
    const result = await checkFileExists(repoPath, location);
    if (result.exists) {
      return true;
    }
  }
  
  return false;
}

/**
 * Determine the appropriate install command based on project type
 */
function determineInstallCommand(
  isGradleKts: boolean,
  isGradle: boolean,
  hasGradleWrapper: boolean
): string {
  if (isGradleKts || isGradle) {
    return hasGradleWrapper ? './gradlew dependencies' : 'gradle dependencies';
  }
  
  // Default install command
  return '';
}

/**
 * Determine the appropriate build command based on project type
 */
function determineBuildCommand(
  isGradleKts: boolean,
  isGradle: boolean,
  hasGradleWrapper: boolean
): string {
  if (isGradleKts || isGradle) {
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
  isGradleKts: boolean,
  isGradle: boolean,
  gradleKtsContent?: string,
  gradleContent?: string
): Promise<{ runCommand: string; args: string[] }> {
  // Always use java directly
  const runCommand = 'java';
  const args: string[] = [];
  
  // Add -jar argument
  args.push('-jar');
  
  // Try to find the actual JAR file
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
    
    // Check for JAR with dependencies
    const depJarPath = 'build/libs/*-with-dependencies.jar';
    const depJarExists = await checkFileExists(repoPath, depJarPath);
    
    if (depJarExists.exists) {
      args.push(depJarPath);
      return { runCommand, args };
    }
    
    // Try to extract main class name from build files to find the right JAR
    let mainClassName = '';
    
    if (isGradleKts && gradleKtsContent) {
      // Look for mainClass in build.gradle.kts
      const mainClassMatch = gradleKtsContent.match(/mainClass\.set\(["']([^"']+)["']\)/);
      if (mainClassMatch) {
        mainClassName = mainClassMatch[1];
      }
    } else if (isGradle && gradleContent) {
      // Look for mainClassName in build.gradle
      const mainClassMatch = gradleContent.match(/mainClassName\s*=\s*['"]([^'"]+)['"]/);
      if (mainClassMatch) {
        mainClassName = mainClassMatch[1];
      }
    }
    
    if (mainClassName) {
      // Try to find a JAR with a name related to the main class
      const mainClassParts = mainClassName.split('.');
      const simpleClassName = mainClassParts[mainClassParts.length - 1].toLowerCase();
      
      // Check build/libs directory for JARs matching the class name
      const classNameJarPath = `build/libs/*${simpleClassName}*.jar`;
      const classNameJarExists = await checkFileExists(repoPath, classNameJarPath);
      
      if (classNameJarExists.exists) {
        args.push(classNameJarPath);
        return { runCommand, args };
      }
    }
    
    // Default to any JAR in build/libs directory
    args.push('build/libs/*.jar');
    return { runCommand, args };
  } catch (error) {
    log.error('Error determining Kotlin JAR path:', error);
  }
  
  // If we couldn't determine a specific path, use a default
  if (args.length === 1) { // Only -jar is in args
    // Try to find any JAR file in common locations
    const jarLocations = [
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
    
    // Default to build/libs/*.jar if nothing else found
    args.push('build/libs/*.jar');
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
