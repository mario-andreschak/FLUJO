import { MessageState } from '../types';


export const installDependencies = async (
  serverPath: string,
  installCommand: string
): Promise<{
  success: boolean;
  message: MessageState;
  output?: string;
}> => {
  try {
   
    // Call the server-side git API to install dependencies
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'install',
        savePath: serverPath,
        installCommand: installCommand
      }),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || 'Failed to install dependencies');
    }
    
    return {
      success: true,
      message: {
        type: 'success',
        text: `Dependencies installed successfully. You can now build the server.`
      },
      output: result.commandOutput || 'No output was returned from the installation process.'
    };
  } catch (error) {
    console.error('Error installing dependencies:', error);
    
    return {
      success: false,
      message: {
        type: 'error',
        text: `Error installing dependencies: ${(error as Error).message || 'Unknown error'}. You can still try to build the server.`
      },
      output: error instanceof Response ? await error.text() : (error as any)?.message || 'Unknown error'
    };
  }
};

export const buildServer = async (
  serverPath: string,
  buildCommand: string
): Promise<{
  success: boolean;
  message: MessageState;
  output?: string;
}> => {
  try {
    // Call the server-side git API to build the repository
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'build',
        savePath: serverPath,
        buildCommand: buildCommand
      }),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.error || 'Failed to build repository');
    }
    
    return {
      success: true,
      message: {
        type: 'success',
        text: `Server built successfully.`
      },
      output: result.commandOutput || 'No output was returned from the build process.'
    };
  } catch (error) {
    console.error('Error building server:', error);
    
    return {
      success: false,
      message: {
        type: 'error',
        text: `Error building server: ${(error as Error).message || 'Unknown error'}.`
      },
      output: error instanceof Response ? await error.text() : (error as any)?.message || 'Unknown error'
    };
  }
};
