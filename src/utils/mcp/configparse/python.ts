'use client';

import { ConfigParseOptions, ConfigParseResult } from './types';
import { checkFileExists, readFile } from './utils';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/configparse/python');

/**
 * Parse Python repository configuration
 */
export async function parsePythonConfig(options: ConfigParseOptions): Promise<ConfigParseResult> {
  const { repoPath, repoName } = options;
  
  log.debug(`Parsing Python configuration for ${repoPath}`);
  
  // Check for Python project files
  const requirementsResult = await checkFileExists(repoPath, 'requirements.txt');
  const pyprojectResult = await checkFileExists(repoPath, 'pyproject.toml', true);
  const setupPyResult = await checkFileExists(repoPath, 'setup.py', true);
  
  if (!requirementsResult.exists && !pyprojectResult.exists && !setupPyResult.exists) {
    log.debug(`No Python project files found in ${repoPath}`);
    return {
      detected: false,
      language: 'python',
      message: {
        type: 'warning',
        text: 'No Python project files found in the repository.'
      }
    };
  }
  
  // Determine install command
  const installCommand = determineInstallCommand(requirementsResult.exists, pyprojectResult.exists);
  
  // Determine run command and args
  const { runCommand, args } = await determineRunCommand(repoPath, pyprojectResult.content, setupPyResult.content);
  
  // Check for .env.example
  const envVars = await extractEnvVars(repoPath);
  
  return {
    detected: true,
    language: 'python',
    installCommand,
    buildCommand: '', // Python typically doesn't need a build step
    runCommand,
    args,
    env: envVars,
    message: {
      type: 'success',
      text: `Python configuration detected successfully.`
    },
    config: {
      name: repoName,
      transport: 'stdio',
      command: runCommand,
      args,
      env: envVars,
      _buildCommand: '',
      _installCommand: installCommand
    }
  };
}

/**
 * Determine the appropriate install command based on project files
 */
function determineInstallCommand(hasRequirements: boolean, hasPyproject: boolean): string {
  // Check for UV first (newer, faster package manager)
  try {
    // This is just a heuristic - we can't actually check if UV is installed
    if (hasRequirements) {
      return 'uv pip install -r requirements.txt --system';
    } else if (hasPyproject) {
      return 'uv pip install -e . --system';
    }
  } catch (error) {
    // UV not available, fall back to pip
  }
  
  // Fall back to pip
  if (hasRequirements) {
    return 'pip install -r requirements.txt';
  } else if (hasPyproject) {
    return 'pip install -e .';
  }
  
  // Default install command
  return 'pip install -e .';
}

/**
 * Determine the appropriate run command and arguments
 * Always use direct python command instead of scripts
 */
async function determineRunCommand(
  repoPath: string,
  pyprojectContent?: string,
  setupPyContent?: string
): Promise<{ runCommand: string; args: string[] }> {
  // Always use python directly
  const runCommand = 'python';
  const args: string[] = [];
  
  // Check for common entry point files
  const commonEntryPoints = [
    'main.py',
    'app.py',
    'server.py',
    'run.py',
    'index.py',
    'src/main.py',
    'src/app.py',
    'src/server.py',
    'src/run.py',
    'src/index.py'
  ];
  
  // Try to find an entry point file
  for (const entryPoint of commonEntryPoints) {
    const exists = await checkFileExists(repoPath, entryPoint);
    if (exists.exists) {
      args.push(entryPoint);
      return { runCommand, args };
    }
  }
  
  // Check for a module name in pyproject.toml
  if (pyprojectContent) {
    try {
      // Look for [tool.poetry.scripts] section
      const poetryScriptsMatch = pyprojectContent.match(/\[tool\.poetry\.scripts\]([\s\S]*?)(\[|$)/);
      if (poetryScriptsMatch) {
        const scriptsSection = poetryScriptsMatch[1];
        const scriptMatch = scriptsSection.match(/(\w+)\s*=\s*["']([^"']+)['"]/);
        if (scriptMatch) {
          // Use the module path as the argument
          const modulePath = scriptMatch[2];
          args.push('-m');
          args.push(modulePath);
          return { runCommand, args };
        }
      }
      
      // Look for [project] section with name
      const projectNameMatch = pyprojectContent.match(/\[project\][\s\S]*?name\s*=\s*["']([^"']+)['"]/);
      if (projectNameMatch) {
        const moduleName = projectNameMatch[1].replace(/-/g, '_');
        args.push('-m');
        args.push(moduleName);
        return { runCommand, args };
      }
    } catch (error) {
      log.error('Error parsing pyproject.toml:', error);
    }
  }
  
  // Check for a module name in setup.py
  if (setupPyContent) {
    try {
      const nameMatch = setupPyContent.match(/name\s*=\s*["']([^"']+)['"]/);
      if (nameMatch) {
        const moduleName = nameMatch[1].replace(/-/g, '_');
        args.push('-m');
        args.push(moduleName);
        return { runCommand, args };
      }
    } catch (error) {
      log.error('Error parsing setup.py:', error);
    }
  }
  
  // If we couldn't find anything, use a default
  if (args.length === 0) {
    args.push('main.py');
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
