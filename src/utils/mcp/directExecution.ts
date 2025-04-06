import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('utils/mcp/directExecution');

// Type definition for command execution options
export type CommandExecutionOptions = {
  savePath: string;
  command: string;
  args?: string[];
  env?: Record<string, string | { value: string; metadata?: { isSecret?: boolean; [key: string]: unknown } }>;
  actionName: string;
  requestId: string;
  timeout?: number;
};

export type CommandExecutionResult = {
  success: boolean;
  commandOutput?: string;
  error?: string;
};

/**
 * Execute a command directly to capture its output
 * This is a simplified version of the executeCommandInRepo function from api/git/route.ts
 * Used primarily for error capture when the regular MCP connection fails
 */
export async function executeCommand({
  savePath,
  command,
  args,
  env,
  actionName,
  requestId,
  timeout
}: CommandExecutionOptions): Promise<CommandExecutionResult> {
  if (!savePath) {
    log.error(`Missing path for command execution [${requestId}]`);
    return { success: false, error: 'Missing path for command execution' };
  }
  
  try {
    // Format the command with args
    let finalCommand = command || '';
    
    // Append arguments if provided
    if (args && args.length > 0) {
      // Filter out empty arguments
      const validArgs = args.filter(arg => arg.trim() !== '');
      if (validArgs.length > 0) {
        log.debug(`Appending ${validArgs.length} arguments to command [${requestId}]`);
        // Join arguments with spaces, properly handling arguments with spaces
        const argsString = validArgs.map(arg => {
          // If argument contains spaces, wrap it in quotes
          return arg.includes(' ') ? `"${arg}"` : arg;
        }).join(' ');
        finalCommand = `${finalCommand} ${argsString}`;
      }
    }
    
    log.debug(`[${actionName}] command: ${finalCommand} [${requestId}]`);
    
    // Execute the command
    try {
      log.info(`Executing [${actionName}] command: ${finalCommand} in ${savePath} [${requestId}]`);
      
      // Create exec options
      const execOptions: ExecSyncOptionsWithStringEncoding = {
        cwd: savePath,
        stdio: 'pipe' as const, // Capture output instead of inheriting
        encoding: 'utf8', // Specify encoding to get string output directly
        env: {
          ...process.env,
          // Transform env variables with metadata to simple string values
          ...(env ? Object.fromEntries(
            Object.entries(env).map(([key, value]) => {
              // Check if the env variable is an object with a 'value' property
              if (value && typeof value === 'object' && 'value' in value) {
                return [key, value.value];
              }
              // If it's already a simple value, use it as is
              return [key, value as string];
            })
          ) : {})
        }
      };
      
      // Add timeout if specified
      if (timeout) {
        execOptions.timeout = timeout;
      }
      
      const commandOutput = execSync(finalCommand, execOptions);
      log.info(`[${actionName}] command executed successfully [${requestId}]`);
      
      return {
        success: true,
        commandOutput
      };
    } catch (error) {
      // If the command fails, capture the error output
      log.error(`[${actionName}] command failed [${requestId}]`, error);
      const execError = error as { stdout?: Buffer; stderr?: Buffer; killed?: boolean; code?: string };
      
      // Check if the process was killed due to timeout
      if (execError.killed && execError.code === 'ETIMEDOUT') {
        log.info(`[${actionName}] command timed out [${requestId}]`);
        return {
          success: false,
          commandOutput: "Command timed out. This is expected for servers that run continuously."
        };
      }
      
      // Combine stdout and stderr output
      let commandOutput = '';
      if (execError.stdout) {
        commandOutput += execError.stdout.toString();
      }
      if (execError.stderr) {
        commandOutput += execError.stderr.toString();
      }
      
      return {
        success: false,
        commandOutput: commandOutput || `Command failed: ${finalCommand}`
      };
    }
  } catch (error) {
    log.error(`Error executing command [${requestId}]`, error);
    return { 
      success: false, 
      error: `Failed to execute command: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}
