'use client';

import { ConfigParseOptions, ConfigParseResult } from './types';
import { checkFileExists, readFile } from './utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/configparse/typescript');

/**
 * Parse TypeScript/JavaScript repository configuration
 */
export async function parseTypeScriptConfig(options: ConfigParseOptions): Promise<ConfigParseResult> {
  const { repoPath, repoName } = options;
  
  log.debug(`Parsing TypeScript configuration for ${repoPath}`);
  
  // Check if package.json exists
  const packageJsonResult = await checkFileExists(repoPath, 'package.json', true);
  
  if (!packageJsonResult.exists || !packageJsonResult.content) {
    log.debug(`No package.json found in ${repoPath}`);
    return {
      detected: false,
      language: 'typescript',
      message: {
        type: 'warning',
        text: 'No package.json found in the repository.'
      }
    };
  }
  
  try {
    // Parse package.json
    const packageJson = JSON.parse(packageJsonResult.content);
    log.debug(`Successfully parsed package.json for ${repoPath}`);
    
    // Extract configuration
    const installCommand = determineInstallCommand(packageJson);
    const buildCommand = determineBuildCommand(packageJson);
    const runCommand = determineRunCommand(packageJson);
    const args = await determineArgs(packageJson, repoPath);
    
    // Check for .env.example
    const envVars = await extractEnvVars(repoPath);
    
    // Check for tsconfig.json to confirm it's a TypeScript project
    const isTsProject = await checkFileExists(repoPath, 'tsconfig.json');
    const language = isTsProject.exists ? 'typescript' : 'typescript'; // Still typescript for JS projects
    
    return {
      detected: true,
      language,
      installCommand,
      buildCommand,
      runCommand,
      args,
      env: envVars,
      message: {
        type: 'success',
        text: `TypeScript/JavaScript configuration detected successfully.`
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
  } catch (error) {
    log.error(`Error parsing package.json for ${repoPath}:`, error);
    return {
      detected: false,
      language: 'typescript',
      message: {
        type: 'error',
        text: `Error parsing package.json: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    };
  }
}

/**
 * Determine the appropriate install command based on package.json
 */
function determineInstallCommand(packageJson: any): string {
  // Check for yarn.lock, pnpm-lock.yaml, or package-lock.json to determine package manager
  if (packageJson.packageManager) {
    if (packageJson.packageManager.startsWith('yarn')) {
      return 'yarn install';
    } else if (packageJson.packageManager.startsWith('pnpm')) {
      return 'pnpm install';
    }
  }
  
  // Default to npm
  return 'npm install';
}

/**
 * Determine the appropriate build command based on package.json scripts
 */
function determineBuildCommand(packageJson: any): string {
  const scripts = packageJson.scripts || {};
  
  // Check for common build script names
  if (scripts.build) {
    return 'npm run build';
  } else if (scripts.compile) {
    return 'npm run compile';
  } else if (scripts.dist) {
    return 'npm run dist';
  } else if (scripts.prepare && scripts.prepare.includes('build')) {
    return 'npm run prepare';
  }
  
  // No build script found
  return '';
}

/**
 * Determine the appropriate run command and arguments based on package.json
 * Instead of using npm scripts directly, we resolve to the actual node command
 */
function determineRunCommand(packageJson: any): string {
  // Always use node directly instead of npm scripts
  return 'node';
}

/**
 * Determine the arguments for the run command
 * This resolves npm scripts to their actual entry points
 */
async function determineArgs(packageJson: any, repoPath: string): Promise<string[]> {
  const scripts = packageJson.scripts || {};
  const main = packageJson.main || '';
  const args: string[] = [];
  
  // Try to determine output directory from build script
  let outputDir = 'dist';
  if (scripts.build) {
    // Check for output directory in build script
    const buildScript = scripts.build;
    
    // Check for --outDir or -d flag in tsc command
    const outDirMatch = buildScript.match(/tsc\s+.*(?:--outDir\s+|--outDir=|--outDir\s*=\s*|--out-dir\s+|--out-dir=|--out-dir\s*=\s*|--out\s+|--out=|--out\s*=\s*|-d\s+|-d=|-d\s*=\s*)["']?([^"'\s]+)["']?/);
    if (outDirMatch && outDirMatch[1]) {
      outputDir = outDirMatch[1];
      log.debug(`Extracted output directory from build script: ${outputDir}`);
    }
    
    // Check for output directory in webpack/rollup/vite config
    const webpackOutDirMatch = buildScript.match(/(?:webpack|rollup|vite).*(?:--output\s+|--output=|--output\s*=\s*|-o\s+|-o=|-o\s*=\s*)["']?([^"'\s]+)["']?/);
    if (webpackOutDirMatch && webpackOutDirMatch[1]) {
      outputDir = webpackOutDirMatch[1];
      log.debug(`Extracted output directory from webpack/rollup/vite build script: ${outputDir}`);
    }
    
    // Check for 'build' directory in build script
    if (buildScript.includes('build/') || buildScript.includes('build\\')) {
      outputDir = 'build';
      log.debug(`Found 'build' directory reference in build script`);
    }
  }
  
  // Try to resolve npm start script to actual entry point
  if (scripts.start) {
    // Parse the start script to extract the actual command
    const startScript = scripts.start;
    
    // Check if it's a direct node command
    const nodeCommandMatch = startScript.match(/node\s+([^\s]+)/);
    if (nodeCommandMatch && nodeCommandMatch[1]) {
      args.push(nodeCommandMatch[1]);
      return args;
    }
    
    // Check if it's using ts-node
    const tsNodeMatch = startScript.match(/ts-node\s+([^\s]+)/);
    if (tsNodeMatch && tsNodeMatch[1]) {
      // Convert ts file to js file in the detected output directory
      const tsFile = tsNodeMatch[1];
      const jsFile = tsFile.replace(/\.ts$/, '.js').replace(/^src\//, `${outputDir}/`);
      args.push(jsFile);
      return args;
    }
  }
  
  // If main is specified in package.json, use it as an argument
  if (main && !main.endsWith('.ts')) {
    args.push(main);
    return args;
  }
  
  // Check for entry point in the detected output directory first
  const outputEntryPoint = `${outputDir}/index.js`;
  const outputEntryExists = await checkFileExists(repoPath, outputEntryPoint);
  if (outputEntryExists.exists) {
    args.push(outputEntryPoint);
    return args;
  }
  
  // Check for common entry point patterns
  const commonEntryPoints = [
    'dist/index.js',
    'build/index.js',
    'lib/index.js',
    'out/index.js'
  ];
  
  for (const entryPoint of commonEntryPoints) {
    const exists = await checkFileExists(repoPath, entryPoint);
    if (exists.exists) {
      args.push(entryPoint);
      return args;
    }
  }
  
  // If we couldn't find anything, use the detected output directory
  args.push(`${outputDir}/index.js`);
  return args;
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
