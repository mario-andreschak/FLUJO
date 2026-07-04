import { NextRequest, NextResponse } from 'next/server';
import simpleGit from 'simple-git';
import path from 'path';
import fs from 'fs/promises';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { processPathLikeArgument } from '@/utils/mcp'

const log = createLogger('app/api/git/route');

// Type definition for command execution options
type CommandExecutionOptions = {
  savePath: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  actionName: string;
  requestId: string;
};
// Define a base directory for storing cloned repositories
// Using a directory inside .next to ensure it's writable in production
const REPOS_BASE_DIR = path.join(process.cwd(), 'mcp-servers');
log.debug(`Repository base directory: ${REPOS_BASE_DIR}`);

// Ensure the base directory exists
async function ensureReposDir() {
  log.debug('Ensuring repository base directory exists');
  try {
    await fs.access(REPOS_BASE_DIR);
    log.debug('Repository base directory already exists');
  } catch {
    log.debug('Creating repository base directory');
    await fs.mkdir(REPOS_BASE_DIR, { recursive: true });
    log.debug('Repository base directory created successfully');
  }
}

// Result shape for update checks on cloned server repositories
type RepoUpdateStatus = {
  isGitRepo: boolean;
  repoRoot?: string;
  remoteUrl?: string;
  branch?: string;
  localSha?: string;
  remoteSha?: string;
  updateAvailable: boolean;
  hasLocalChanges: boolean;
  dirtyFiles: string[];
  error?: string;
};

// Resolve the ref to compare against: the checked-out branch, or the remote HEAD
// when the clone is in detached-HEAD state (e.g. cloned at a tag/commit).
function remoteRefForBranch(branch: string): string {
  return branch && branch !== 'HEAD' ? `refs/heads/${branch}` : 'HEAD';
}

// Find the git repository containing savePath, walking upward like git itself does.
// Server rootPaths often point at a subdirectory of a monorepo clone (e.g.
// mcp-servers/servers/src/everything), so probing savePath/.git is not enough.
// Returns null when savePath is missing or not inside any repository.
async function resolveRepoRoot(savePath: string): Promise<string | null> {
  try {
    await fs.access(savePath);
  } catch {
    return null;
  }
  try {
    const git = simpleGit({ baseDir: savePath, timeout: { block: 15000 } });
    const top = (await git.revparse(['--show-toplevel'])).trim();
    return top || null;
  } catch {
    return null;
  }
}

// Guard: never treat FLUJO's own repository as an updatable server clone. A rootPath
// that resolves upward into the app repo (e.g. a hand-configured local server living
// inside the project folder) must not offer a pull, since the update runs a hard reset
// on the whole repository.
function isFlujoAppRepo(repoRoot: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  return norm(repoRoot) === norm(process.cwd());
}

// Check whether a cloned repository is behind its origin. Uses `ls-remote` (a single
// cheap network round-trip) instead of a fetch, so it is safe to run in batches on
// page load. Never throws: failures are reported in the `error` field so a batch
// check degrades per-repository instead of failing wholesale.
async function checkRepoUpdateStatus(savePath: string, requestId: string): Promise<RepoUpdateStatus> {
  const status: RepoUpdateStatus = {
    isGitRepo: false,
    updateAvailable: false,
    hasLocalChanges: false,
    dirtyFiles: []
  };

  const repoRoot = await resolveRepoRoot(savePath);
  if (!repoRoot) {
    log.debug(`Not inside a git repository: ${savePath} [${requestId}]`);
    return status;
  }
  if (isFlujoAppRepo(repoRoot)) {
    log.debug(`Path resolves to the FLUJO app repository, skipping: ${savePath} [${requestId}]`);
    status.error = 'Path is inside the FLUJO application repository';
    return status;
  }
  status.isGitRepo = true;
  status.repoRoot = repoRoot;

  try {
    const git = simpleGit({ baseDir: repoRoot, timeout: { block: 15000 } });

    const remoteUrl = ((await git.remote(['get-url', 'origin'])) || '').trim();
    if (!remoteUrl) {
      status.error = 'No origin remote configured';
      return status;
    }
    status.remoteUrl = remoteUrl;

    status.localSha = (await git.revparse(['HEAD'])).trim();
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    status.branch = branch;

    const ref = remoteRefForBranch(branch);
    let lsRemote = await git.listRemote(['origin', ref]);
    if (!lsRemote.trim() && ref !== 'HEAD') {
      // Branch no longer exists on the remote (renamed default branch etc.) - fall
      // back to the remote HEAD so the user can still update onto the new default.
      log.debug(`Remote ref ${ref} not found, falling back to HEAD [${requestId}]`);
      lsRemote = await git.listRemote(['origin', 'HEAD']);
    }
    const remoteSha = lsRemote.trim().split('\n')[0]?.split(/\s+/)[0] || '';
    if (!remoteSha) {
      status.error = `Could not resolve remote ref ${ref}`;
      return status;
    }
    status.remoteSha = remoteSha;
    status.updateAvailable = remoteSha !== status.localSha;

    // Tracked-file modifications only: untracked files (like a user-created .env)
    // survive the update, so they are not a reason to warn.
    const porcelain = await git.raw(['status', '--porcelain', '--untracked-files=no']);
    status.dirtyFiles = porcelain
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^\S+\s+/, ''));
    status.hasLocalChanges = status.dirtyFiles.length > 0;

    return status;
  } catch (error) {
    log.warn(`Update check failed for ${savePath} [${requestId}]`, error);
    status.error = error instanceof Error ? error.message : 'Unknown error';
    return status;
  }
}

// Helper function to execute a command in a repository directory
async function executeCommandInRepo({ savePath, command, args, actionName, requestId, env }: CommandExecutionOptions) {
  if (!savePath) {
    log.error(`Missing repository path [${requestId}]`);
    return NextResponse.json({ error: 'Missing repository path' }, { status: 400 });
  }
  
  try {
    // Check if directory exists
    log.debug(`Checking if directory exists [${requestId}]`);
    await fs.access(savePath);
    log.debug(`Directory exists, proceeding [${requestId}]`);
    
    // Use the command provided by the frontend
    log.debug(`Using ${actionName} command from frontend [${requestId}]`);
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
    
    log.debug(`${actionName} command: ${finalCommand} [${requestId}]`);
    
    // Execute the command
    try {
      log.info(`Executing ${actionName} command: ${finalCommand} in ${savePath} [${requestId}]`);
      
      // Execute the command in the repository directory and capture output
      let commandOutput;
      try {
        log.debug(`Running ${actionName} command [${requestId}]`);
        
        // Create exec options
        const execOptions: ExecSyncOptionsWithStringEncoding = {
          cwd: savePath,
          stdio: 'pipe' as const, // Capture output instead of inheriting
          encoding: 'utf8', // Specify encoding to get string output directly
          env: {
            ...process.env,
            ...env
          }
        };
        
        // Add timeout for "Run" action
        if (actionName === 'Run') {
          log.debug(`Adding 10-second timeout for Run command [${requestId}]`);
          execOptions.timeout = 10000; // 10 seconds in milliseconds
        }
        
        commandOutput = execSync(finalCommand, execOptions);
        log.info(`${actionName} command executed successfully [${requestId}]`);
        log.debug(`${actionName} output summary [${requestId}]`, { 
          outputLength: commandOutput.length,
          outputPreview: commandOutput.substring(0, 200) + (commandOutput.length > 200 ? '...' : '')
        });
      } catch (error) {
        // If the command fails, capture the error output
        log.error(`${actionName} command failed [${requestId}]`, error);
        const execError = error as { stdout?: Buffer; stderr?: Buffer; killed?: boolean; code?: string };
        
        // Check if the process was killed due to timeout
        if (execError.killed && execError.code === 'ETIMEDOUT') {
          log.info(`${actionName} command timed out after 10 seconds [${requestId}]`);
          commandOutput = "Command timed out after 10 seconds. This is expected for MCP servers that start successfully.";
          
          // For timeouts on "Run" action, we consider this a success
          if (actionName === 'Run') {
            log.info(`Run command timeout considered successful [${requestId}]`);
            
            // Return success with timeout information
            const response = {
              success: true,
              path: savePath,
              relativePath: savePath,
              [`${actionName}Command`]: finalCommand,
              commandOutput: commandOutput,
              timedOut: true
            };
            
            log.info(`Returning successful response for timed out Run command [${requestId}]`);
            return NextResponse.json(response);
          }
        }
        
        commandOutput = execError.stdout?.toString() || '';
        commandOutput += execError.stderr?.toString() || '';
        log.debug(`${actionName} command output [${requestId}]`, {
          outputLength: commandOutput.length,
          outputPreview: commandOutput.substring(0, 200) + (commandOutput.length > 200 ? '...' : '')
        });
        throw new Error(`Command failed: ${finalCommand}\n${commandOutput}`);
      }
      
      // Return success with repository info
      log.debug(`Preparing successful response [${requestId}]`);
      const response = {
        success: true,
        path: savePath,
        relativePath: savePath,
        [`${actionName}Command`]: finalCommand,
        commandOutput: commandOutput // Include the command output
      };
      log.info(`Returning successful response [${requestId}]`, { 
        success: response.success,
        path: response.path,
        relativePath: response.relativePath
      });
      return NextResponse.json(response);
    } catch (commandError) {
      log.error(`${actionName} command execution failed [${requestId}]`, commandError);
      // Extract command output from error if available
      let commandOutput = `${actionName} output not available`;
      if (commandError instanceof Error) {
        commandOutput = commandError.message || 'Unknown error';
        
        // Check if it's an exec error with stdout/stderr
        const execError = commandError as unknown as { stdout?: Buffer; stderr?: Buffer };
        if (execError.stdout || execError.stderr) {
          commandOutput = (execError.stdout?.toString() || '') + (execError.stderr?.toString() || '');
          log.debug(`${actionName} error output [${requestId}]`, {
            outputLength: commandOutput.length,
            outputPreview: commandOutput.substring(0, 200) + (commandOutput.length > 200 ? '...' : '')
          });
        }
      }
      
      log.error(`Returning error response for ${actionName} failure [${requestId}]`);
      return NextResponse.json({ 
        error: `Failed to ${actionName.toLowerCase()} repository: ${commandError instanceof Error ? commandError.message : 'Unknown error'}`,
        path: savePath,
        relativePath: savePath,
        [`${actionName}Command`]: finalCommand,
        commandOutput
      }, { status: 500 });
    }
  } catch (error) {
    log.error(`Repository ${actionName.toLowerCase()} error [${requestId}]`, error);
    return NextResponse.json({ 
      error: `Failed to ${actionName.toLowerCase()} repository: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const requestId = uuidv4();
  log.info(`Received new request [RequestID: ${requestId}]`);
  
  try {
    const requestBody = await request.json();
    const { action, repoUrl, savePath, branch, buildCommand, installCommand, runCommand, env} = requestBody;
    
    log.debug(`Request parameters [${requestId}]`, { 
      action, 
      repoUrl, 
      savePath, 
      branch, 
      buildCommand, 
      installCommand,
      runCommand,
    });

    if (!action) {
      log.error(`Missing action parameter [${requestId}]`);
      return NextResponse.json({ error: 'Missing action parameter' }, { status: 400 });
    }

    await ensureReposDir();
    log.info(`Executing action: ${action} [${requestId}]`);

    switch (action) {
      
      case 'exists': {
        log.info(`Starting exists action [${requestId}]`);
        if (!savePath) {
          log.error(`Missing save path [${requestId}]`);
          return NextResponse.json({ error: 'Missing save path' }, { status: 400 });
        }

        try {
          // Check if directory exists
          log.debug(`Checking if path exists: ${savePath} [${requestId}]`);
          let exists = false;
          try {
            await fs.access(savePath);
            exists = true;
            log.debug(`Path exists: ${savePath} [${requestId}]`);
          } catch {
            log.debug(`Path does not exist: ${savePath} [${requestId}]`);
          }

          log.info(`Returning exists response: ${exists} [${requestId}]`);
          return NextResponse.json({
            success: true,
            exists
          });
        } catch (error) {
          log.error(`Error checking if path exists [${requestId}]`, error);
          return NextResponse.json({ 
            error: `Failed to check if path exists: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }, { status: 500 });
        }
      }

      case 'run': {
        log.info(`Starting run action [${requestId}]`);
        const runCommand = requestBody.runCommand;
        const args = requestBody.args;
        
        // Log arguments if provided
        if (args && args.length > 0) {
          log.debug(`Run command arguments [${requestId}]:`, args);
        }
        
        return executeCommandInRepo({
          savePath,
          command: runCommand,
          args,
          env,
          actionName: 'Run',
          requestId
        });
      }
      
      case 'install': {
        log.info(`Starting install action [${requestId}]`);
        return executeCommandInRepo({
          savePath,
          command: installCommand,
          actionName: 'Install',
          requestId
        });
      }
      case 'clone': {
        log.info(`Starting clone action [${requestId}]`);
        if (!repoUrl) {
          log.error(`Missing repository URL [${requestId}]`);
          return NextResponse.json({ error: 'Missing repository URL' }, { status: 400 });
        }

        if (!savePath) {
          log.error(`Missing save path [${requestId}]`);
          return NextResponse.json({ error: 'Missing save path' }, { status: 400 });
        }

        // Get the forceClone parameter from the request
        const forceClone = requestBody.forceClone === true;
        log.debug(`Force clone parameter: ${forceClone} [${requestId}]`);

        // Ensure the parent directory exists
        log.debug(`Ensuring parent directory exists: ${path.dirname(savePath)} [${requestId}]`);
        await fs.mkdir(path.dirname(savePath), { recursive: true });
        
        // Check if directory already exists
        let directoryExists = false;
        try {
          log.debug(`Checking if directory already exists [${requestId}]`);
          await fs.access(savePath);
          directoryExists = true;
          
          // If forceClone is true, remove the existing directory
          if (forceClone) {
            log.info(`Force clone requested, removing existing directory at ${savePath} [${requestId}]`);
            try {
              // Use rimraf-like recursive removal with fs.rm
              await fs.rm(savePath, { recursive: true, force: true });
              log.info(`Existing directory removed successfully [${requestId}]`);
              directoryExists = false;
            } catch (rmError) {
              log.error(`Error removing existing directory [${requestId}]`, rmError);
              return NextResponse.json({ 
                error: `Failed to remove existing directory: ${rmError instanceof Error ? rmError.message : 'Unknown error'}` 
              }, { status: 500 });
            }
          } else {
            log.debug(`Directory already exists at ${savePath}, continuing with existing repository [${requestId}]`);
          }
        } catch {
          log.debug(`Directory does not exist, will clone repository [${requestId}]`);
          // Directory doesn't exist, which is what we want
        }

        try {
          log.debug(`Initializing simple-git [${requestId}]`);
          const git = simpleGit();
          
          // Clone options
          const options: Record<string, string | number> = {
            '--depth': 1,  // Shallow clone for faster download
          };
          log.debug(`Clone options [${requestId}]`, options);
          
          // Add branch if specified
          if (branch) {
            log.debug(`Using specific branch: ${branch} [${requestId}]`);
            options['--branch'] = branch;
          }
          
          // Clone the repository if it doesn't already exist
          if (!directoryExists) {
            log.info(`Cloning repository from ${repoUrl} to ${savePath} [${requestId}]`);
            await git.clone(repoUrl, savePath, options);
            log.info(`Repository cloned successfully [${requestId}]`);
          }
          
          // Get .env.example if it exists
          log.debug(`Checking for .env.example [${requestId}]`);
          let envExample = null;
          try {
            const envExamplePath = path.join(savePath, '.env.example');
            log.debug(`Reading .env.example from: ${envExamplePath} [${requestId}]`);
            envExample = await fs.readFile(envExamplePath, 'utf-8');
            log.debug(`.env.example found [${requestId}]`, { 
              length: envExample.length 
            });
          } catch (err) {
            log.debug(`No .env.example found [${requestId}]`, err);
            // No .env.example, which is fine
          }
          
          // Return success with repository info
          log.debug(`Preparing successful response [${requestId}]`);
          const response = {
            success: true,
            path: savePath,
            relativePath: savePath,
            envExample
          };
          log.info(`Returning successful response [${requestId}]`, { 
            success: response.success,
            path: response.path,
            relativePath: response.relativePath
          });
          return NextResponse.json(response);
        } catch (error) {
          log.error(`Git clone error [${requestId}]`, error);
          return NextResponse.json({ 
            error: `Failed to clone repository: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }, { status: 500 });
        }
      }
      
      case 'build': {
        log.info(`Starting build action [${requestId}]`);
        
        // Check for .env.example if needed
        let envExample = null;
        try {
          const envExamplePath = path.join(savePath, '.env.example');
          log.debug(`Reading .env.example from: ${envExamplePath} [${requestId}]`);
          envExample = await fs.readFile(envExamplePath, 'utf-8');
          log.debug(`.env.example found [${requestId}]`, { 
            length: envExample.length 
          });
        } catch (err) {
          log.debug(`No .env.example found [${requestId}]`, err);
          // No .env.example, which is fine
        }
        
        return executeCommandInRepo({
          savePath,
          command: buildCommand || '',
          actionName: 'Build',
          requestId
        });
      }
      
      case 'readFile': {
        log.info(`Starting readFile action [${requestId}]`);
        if (!savePath) {
          log.error(`Missing file path [${requestId}]`);
          return NextResponse.json({ error: 'Missing file path' }, { status: 400 });
        }

        // Determine if the savePath is absolute or relative
        const isAbsolutePath = path.isAbsolute(savePath);
        
        // Construct the full path - if savePath is absolute, use it directly; otherwise join with base dir
        const fullFilePath = isAbsolutePath ? savePath : path.join(REPOS_BASE_DIR, savePath);
        log.debug(`Constructed full file path: ${fullFilePath} [${requestId}] (path is ${isAbsolutePath ? 'absolute' : 'relative'})`);
        
        try {
          // Check if file exists
          log.debug(`Checking if file exists: ${fullFilePath} [${requestId}]`);
          await fs.access(fullFilePath);
          log.debug(`File exists, reading content [${requestId}]`);
          
          // Read the file content
          const content = await fs.readFile(fullFilePath, 'utf-8');
          log.debug(`File content read successfully [${requestId}]`, {
            contentLength: content.length,
            contentPreview: content.substring(0, 200) + (content.length > 200 ? '...' : '')
          });
          
          log.info(`Returning successful response for readFile [${requestId}]`);
          return NextResponse.json({
            success: true,
            path: fullFilePath,
            relativePath: savePath,
            content
          });
        } catch (error) {
          log.error(`File read error [${requestId}]`, error);
          return NextResponse.json({ 
            error: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }, { status: 500 });
        }
      }
      
      case 'listDir': {
        log.info(`Starting listDir action [${requestId}]`);
        if (!savePath) {
          log.error(`Missing directory path [${requestId}]`);
          return NextResponse.json({ error: 'Missing directory path' }, { status: 400 });
        }
        
        try {
          log.debug(`Reading directory: ${savePath} [${requestId}]`);
          const entries = await fs.readdir(savePath, { withFileTypes: true });
          
          // Map entries to objects with name and type properties
          const items = entries.map(entry => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            isHidden: entry.name.startsWith('.') // Identify hidden files/directories
          }));
          
          log.debug(`Found ${items.length} items in directory [${requestId}]`);
          log.info(`Returning successful response for listDir [${requestId}]`);
          return NextResponse.json({
            success: true,
            path: savePath,
            items: items
          });
        } catch (error) {
          log.error(`Failed to list directory contents [${requestId}]`, error);
          return NextResponse.json({ 
            error: `Failed to list directory contents: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }, { status: 500 });
        }
      }
      
      case 'list': {
        log.info(`Starting list action [${requestId}]`);
        try {
          log.debug(`Reading directory: ${REPOS_BASE_DIR} [${requestId}]`);
          const entries = await fs.readdir(REPOS_BASE_DIR, { withFileTypes: true });
          const directories = entries
            .filter(entry => entry.isDirectory())
            .map(dir => dir.name);
          
          log.debug(`Found ${directories.length} repositories [${requestId}]`, directories);
          log.info(`Returning successful response for list [${requestId}]`);
          return NextResponse.json({
            success: true,
            repositories: directories
          });
        } catch (error) {
          log.error(`Failed to list repositories [${requestId}]`, error);
          return NextResponse.json({ 
            error: `Failed to list repositories: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }, { status: 500 });
        }
      }
      
      case 'checkUpdates': {
        log.info(`Starting checkUpdates action [${requestId}]`);
        if (!savePath) {
          log.error(`Missing repository path [${requestId}]`);
          return NextResponse.json({ error: 'Missing repository path' }, { status: 400 });
        }

        const status = await checkRepoUpdateStatus(savePath, requestId);
        log.info(`Update check for ${savePath}: updateAvailable=${status.updateAvailable} [${requestId}]`);
        return NextResponse.json({ success: true, ...status });
      }

      case 'checkUpdatesBatch': {
        log.info(`Starting checkUpdatesBatch action [${requestId}]`);
        const paths = requestBody.paths;
        if (!Array.isArray(paths) || paths.length === 0) {
          log.error(`Missing or empty paths array [${requestId}]`);
          return NextResponse.json({ error: 'Missing paths array' }, { status: 400 });
        }

        const validPaths = paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
        const entries = await Promise.all(
          validPaths.map(async (p) => [p, await checkRepoUpdateStatus(p, requestId)] as const)
        );
        const results = Object.fromEntries(entries);
        log.info(`Batch update check completed for ${validPaths.length} repositories [${requestId}]`);
        return NextResponse.json({ success: true, results });
      }

      case 'pullUpdates': {
        log.info(`Starting pullUpdates action [${requestId}]`);
        if (!savePath) {
          log.error(`Missing repository path [${requestId}]`);
          return NextResponse.json({ error: 'Missing repository path' }, { status: 400 });
        }

        const repoRoot = await resolveRepoRoot(savePath);
        if (!repoRoot) {
          log.error(`Not a git repository: ${savePath} [${requestId}]`);
          return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
        }
        if (isFlujoAppRepo(repoRoot)) {
          log.error(`Refusing to update the FLUJO app repository via ${savePath} [${requestId}]`);
          return NextResponse.json({ error: 'Refusing to update the FLUJO application repository' }, { status: 400 });
        }

        try {
          const git = simpleGit({ baseDir: repoRoot, timeout: { block: 120000 } });

          const oldSha = (await git.revparse(['HEAD'])).trim();
          const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
          const fetchRef = currentBranch && currentBranch !== 'HEAD' ? currentBranch : 'HEAD';

          // Clones are shallow (--depth 1), where a plain `git pull` misbehaves. The
          // shallow-safe update is: fetch the tip at depth 1, then hard-reset onto it.
          // `reset --hard` only touches tracked files, so an untracked .env survives.
          log.info(`Fetching origin/${fetchRef} for ${repoRoot} [${requestId}]`);
          await git.raw(['fetch', '--depth', '1', 'origin', fetchRef]);
          await git.raw(['reset', '--hard', 'FETCH_HEAD']);

          const newSha = (await git.revparse(['HEAD'])).trim();
          log.info(`Repository updated ${oldSha} -> ${newSha} [${requestId}]`);
          return NextResponse.json({
            success: true,
            repoRoot,
            oldSha,
            newSha,
            updated: oldSha !== newSha
          });
        } catch (error) {
          log.error(`Pull updates failed for ${savePath} [${requestId}]`, error);
          return NextResponse.json({
            error: `Failed to pull updates: ${error instanceof Error ? error.message : 'Unknown error'}`
          }, { status: 500 });
        }
      }

      default:
        log.error(`Invalid action: ${action} [${requestId}]`);
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error(`Git API Error [${requestId}]`, error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}
