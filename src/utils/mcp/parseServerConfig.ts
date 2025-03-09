'use client';

import { MCPServerConfig } from "@/shared/types/mcp";
import { ParsedServerConfig } from "./types";
import { processPathLikeArgument } from "./processPathLikeArgument";

/**
 * Parse text content to extract MCP server configuration
 * @param text The text content to parse
 * @param parseEnvVars Whether to parse environment variables (default: true)
 * @param knownServerName Optional known server name to use for path processing
 */
export function parseServerConfig(text: string, parseEnvVars: boolean = true, knownServerName?: string): ParsedServerConfig {
  console.log('parseServerConfig: Starting with text length:', text.length);
  try {
    // Unescape markdown characters
    console.log('parseServerConfig: Unescaping markdown characters');
    const unescapedText = text
      .replace(/\\#/g, '#')
      .replace(/\\\[/g, '[')
      .replace(/\\\]/g, ']')
      .replace(/\\`\\`\\`/g, '```')
      .replace(/\\`/g, '`');
    
    // Save unescaped text for env variable extraction
    const originalText = unescapedText;
    console.log('parseServerConfig: Unescaped text length:', unescapedText.length);

    // We don't want to default-fill any commands, so we'll only look for explicit build/install commands
    // without suggesting any specific language or tool
    console.log('parseServerConfig: Setting up command patterns');
    const buildCommandPattern = /(?:^|\n)\s*(?:build|\.\/build|build\.bat|\.\/build\.bat|build\.sh|\.\/build\.sh|npm run build|npx build|yarn build|pnpm build|vite build|webpack build|gradle build|mvn build|cargo build)\s*(?:$|\n)/m;
    const installCommandPattern = /(?:^|\n)\s*(?:install|\.\/install|install\.bat|\.\/install\.bat|install\.sh|\.\/install\.sh|setup|\.\/setup|setup\.bat|\.\/setup\.bat|setup\.sh|\.\/setup\.sh|npm install|pip install|yarn install|pnpm install|uv install|gem install|cargo install|apt install|apt-get install|brew install)\s*(?:$|\n)/m;
    
    // Look for command patterns in code blocks
    console.log('parseServerConfig: Extracting code blocks');
    const codeBlockPattern = /```(?:bash|sh|cmd|powershell|batch)?\s*([\s\S]*?)```/gm;
    const codeBlocks = [...unescapedText.matchAll(codeBlockPattern)].map(match => match[1]);
    console.log('parseServerConfig: Found', codeBlocks.length, 'code blocks');

    // Extract build and install commands if present
    let buildCommand: string | undefined;
    let installCommand: string | undefined;
    let extractedCommand: string | undefined;
    let extractedCommandArgs: string[] = [];
    
    console.log('parseServerConfig: Looking for build/install commands in main text');
    // First check in the main text
    const buildMatch = originalText.match(buildCommandPattern);
    if (buildMatch) {
      buildCommand = buildMatch[0].trim();
      console.log('parseServerConfig: Found build command in main text:', buildCommand);
    }
    
    const installMatch = originalText.match(installCommandPattern);
    if (installMatch) {
      installCommand = installMatch[0].trim();
      console.log('parseServerConfig: Found install command in main text:', installCommand);
    }
    
    console.log('parseServerConfig: Checking code blocks for commands');
    // Then check in code blocks for more specific commands
    for (let i = 0; i < codeBlocks.length; i++) {
      const codeBlock = codeBlocks[i];
      console.log(`parseServerConfig: Processing code block ${i+1}/${codeBlocks.length}, length: ${codeBlock.length}`);
      
      // Split code block into lines to process each line individually
      const lines = codeBlock.split('\n');
      console.log(`parseServerConfig: Code block has ${lines.length} lines`);
      
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        console.log(`parseServerConfig: Processing line ${j+1}: "${line}"`);
        
        // Look for build commands in code blocks - match lines with just the command
        if (!buildCommand) {
          const buildBlockMatch = line.match(/^[ \t]*(build\.bat|\.\/build\.bat|build\.sh|\.\/build\.sh|npm run build|npx build|yarn build|pnpm build|vite build|webpack build|gradle build|mvn build|cargo build)(?: [\w-]+)*[ \t]*$/);
          if (buildBlockMatch) {
            buildCommand = buildBlockMatch[1].trim();
            console.log(`parseServerConfig: Found build command in code block: ${buildCommand}`);
          }
        }
        
        // Look for install commands in code blocks - match lines with just the command
        if (!installCommand) {
          const installBlockMatch = line.match(/^[ \t]*((?:install\.bat|\.\/install\.bat|install\.sh|\.\/install\.sh|setup\.bat|\.\/setup\.bat|setup\.sh|\.\/setup\.sh|npm install|pip install|yarn install|pnpm install|uv install|gem install|cargo install|apt install|apt-get install|brew install)(?: [\w\.-]+)*)[ \t]*$/);
          if (installBlockMatch) {
            installCommand = installBlockMatch[1].trim();
            console.log(`parseServerConfig: Found install command in code block: ${installCommand}`);
          }
        }
        
        // Look for run commands in code blocks that could be the main command
        // This pattern matches run commands with optional arguments
        console.log(`parseServerConfig: Checking for run command in line: "${line}"`);
        // This pattern captures the command and all arguments that follow
        const runMatch = line.match(/(run\.bat|\.\/run\.bat|run\.sh|\.\/run\.sh|npm start|yarn start|pnpm start|python|node|vite)(?:\s+(.+))?/);
        if (runMatch) {
          console.log(`parseServerConfig: Found potential run command: ${runMatch[0]}`);
          
          // Only set the extracted command if we haven't found one yet
          if (!extractedCommand) {
            // Set just the command part
            extractedCommand = runMatch[1].trim();
            console.log(`parseServerConfig: Set extracted command to: ${extractedCommand}`);
            
            // If there are arguments, store them for later use
            if (runMatch[2]) {
              // Split the arguments by whitespace
              const extractedArgs = runMatch[2].trim().split(/\s+/);
              console.log(`parseServerConfig: Extracted args: ${extractedArgs.join(', ')}`);
              
              // Store these extracted arguments
              extractedCommandArgs = extractedArgs;
            }
          }
        }
      }
    }

    console.log('parseServerConfig: Cleaning text for JSON parsing');
    // Remove single-line comments for JSON parsing
    const cleanText = text.replace(/\/\/.*$/gm, '');

    // Try to extract server config - either from mcpServers structure or direct top-level structure
    let serverName = '';
    let configText = '';
    let foundServerConfig = false;
    let configSource = '';
    console.log('parseServerConfig: Attempting to extract server config');

    // First try the mcpServers structure
    console.log('parseServerConfig: Trying to match mcpServers structure');
    const mcpServersMatch = cleanText.match(/"mcpServers"\s*:\s*{\s*"([^"]+)"\s*:\s*({[^}]+})/);

    if (mcpServersMatch) {
      [, serverName, configText] = mcpServersMatch;
      foundServerConfig = true;
      configSource = 'mcpServers structure';
      console.log('parseServerConfig: Found server config in mcpServers structure for:', serverName);
    } else {
      console.log('parseServerConfig: No mcpServers structure found, trying direct structure');
      // Try the direct top-level structure - looking for "server-name": { ... } pattern with command and args
      // This pattern looks for a JSON object with at least command and args properties
      const directMatch = cleanText.match(/"([^"]+)"\s*:\s*({[^{]*"command"\s*:[^{]*"args"\s*:[^}]*})/);

      if (directMatch) {
        [, serverName, configText] = directMatch;
        foundServerConfig = true;
        configSource = 'direct structure';
        console.log("parseServerConfig: Found direct server configuration for:", serverName);
      } else {
        console.log('parseServerConfig: No valid configuration found in either structure');
        // No valid configuration found, but we'll continue to extract what we can
        
        // Use empty configText to still try to extract what we can
        configText = cleanText;
        console.log('parseServerConfig: Will attempt to extract any available information');
        
        // We'll continue processing instead of returning early
        foundServerConfig = false;
        configSource = 'extracted information';
      }
    }

    console.log('parseServerConfig: Extracting command and args from config');
    // Extract command (string) - even if we didn't find a full server config
    const commandMatch = configText.match(/"command"\s*:\s*"([^"]+)"/);
    const command = commandMatch ? commandMatch[1] : '';
    console.log('parseServerConfig: Extracted command:', command);

    // Extract args (array) - even if we didn't find a full server config
    const argsMatch = configText.match(/"args"\s*:\s*\[([\s\S]*?)\]/);
    const args = argsMatch
      ? argsMatch[1]
          .split(',')
          .map(arg => arg.trim())
          .map(arg => arg.replace(/^"(.*)"$/, '$1'))
          .filter(arg => arg.length > 0)
      : [];
    console.log('parseServerConfig: Extracted args:', args);

    console.log('parseServerConfig: Extracting disabled and autoApprove settings');
    // Extract disabled (boolean) - even if we didn't find a full server config
    const disabledMatch = configText.match(/"disabled"\s*:\s*(true|false)/);
    const disabled = disabledMatch ? disabledMatch[1] === 'true' : false;
    console.log('parseServerConfig: Extracted disabled:', disabled);

    // Extract autoApprove (array) - even if we didn't find a full server config
    const autoApproveMatch = configText.match(/"autoApprove"\s*:\s*\[([\s\S]*?)\]/);
    const autoApprove = autoApproveMatch
      ? autoApproveMatch[1]
          .split(',')
          .map(item => item.trim())
          .map(item => item.replace(/^"(.*)"$/, '$1'))
          .filter(item => item.length > 0)
      : [];
    console.log('parseServerConfig: Extracted autoApprove:', autoApprove);

    // Start with existing env variables if any
    const env: Record<string, string> = {};

    console.log('parseServerConfig: Parsing environment variables, parseEnvVars =', parseEnvVars);
    // Only parse environment variables if parseEnvVars is true
    if (parseEnvVars) {
      // Define the pattern for a single env var at the beginning of a line
      // This pattern is more flexible to handle various formats including those in README files
      const envVarPattern = /^\ *(\w+)=["']?([^"'\r\n#]*)["']?(?:\s*#[^\r\n]*)?(?=\r?\n|$)/gm;
      
      // Also look for environment variables in code blocks or lists in README
      const readmeEnvPattern = /(?:^|\n)[-*]?\s*`?(\w+)`?(?:\s*:|=)\s*[`"']?([^`"'\r\n#]*)(?:[`"'])?(?:\s*#[^\r\n]*)?(?=\r?\n|$)/gm;

      console.log('parseServerConfig: Extracting env vars with standard pattern');
      // Extract env vars using the standard pattern
      const envVars = originalText.matchAll(envVarPattern);
      for (const varMatch of envVars) {
        const key = varMatch[1];
        const value = varMatch[2].trim();
        if (key && value !== undefined) {
          env[key] = value;
          console.log(`parseServerConfig: Found env var (standard): ${key}=${value}`);
        }
      }
      
      console.log('parseServerConfig: Extracting env vars with README pattern');
      // Extract env vars from README-style formats
      const readmeEnvVars = originalText.matchAll(readmeEnvPattern);
      for (const varMatch of readmeEnvVars) {
        const key = varMatch[1];
        const value = varMatch[2].trim();
        if (key && value !== undefined && !env[key]) {  // Don't overwrite existing values
          env[key] = value;
          console.log(`parseServerConfig: Found env var (README): ${key}=${value}`);
        }
      }
    }
    
    console.log('parseServerConfig: Building final config object');
    // Use the extracted command if no command was found in the JSON configuration
    const finalCommand = command || extractedCommand || '';
    console.log('parseServerConfig: Final command:', finalCommand);
    
    // Merge extracted args with any args found in the JSON configuration
    // Only use extracted args if we're using the extracted command and no args were found in JSON
    const finalArgs = (command && args.length > 0) ? args : 
                     (extractedCommand && extractedCommandArgs.length > 0) ? extractedCommandArgs : 
                     args;
    
    // Process path-like arguments using the server name (either extracted or provided)
    const serverNameToUse = knownServerName || serverName;
    const processedArgs = finalArgs.map(arg => processPathLikeArgument(arg, serverNameToUse));
    console.log('parseServerConfig: Final args (after path processing):', processedArgs);
    
    const config: Partial<MCPServerConfig> = {
      name: serverName || '', // No default server name - must be provided by user
      command: finalCommand,
      args: processedArgs, // Use the processed args
      env,
      disabled,
      autoApprove,
      _buildCommand: buildCommand,
      _installCommand: installCommand
    }
    console.log('parseServerConfig: Config object created:', JSON.stringify(config, null, 2));

    console.log('parseServerConfig: Preparing return message');
    // Show appropriate message based on what was found
    if (foundServerConfig) {
      console.log(`parseServerConfig: Returning success - config found in ${configSource}`);
      return {
        config,
        message: {
          type: 'success',
          text: `Configuration for "${serverName}" extracted successfully from ${configSource}.`
        }
      }
    } else {
      // We already set an error message above, but let's update it with what we found
      const extractedItems = [];
      if (command) extractedItems.push('command');
      if (args.length > 0) extractedItems.push('arguments');
      if (Object.keys(env).length > 0) extractedItems.push('environment variables');

      if (extractedItems.length > 0) {
        console.log(`parseServerConfig: Returning warning - partial data extracted: ${extractedItems.join(', ')}`);
        return {
          config,
          message: {
            type: 'warning',
            text: `No complete server configuration found, but extracted: ${extractedItems.join(', ')}.`
          }
        }
      } else {
        console.log('parseServerConfig: Returning error - no data found');
        return {
          config,
          message: {
            type: 'error',
            text: `No server configuration data found.`
          }
        }
      }
    }

  } catch (error) {
    console.error('parseServerConfig: Exception occurred:', error);
    return {
      config: {},
      message: {
        type: 'error',
        text: 'Failed to extract server configuration. Please check the content format.'
      }
    }
  }
}
