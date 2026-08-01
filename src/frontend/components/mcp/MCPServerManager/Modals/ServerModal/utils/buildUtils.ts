import { MessageState } from '../types';
import { translate, type Translator } from '@/frontend/i18n';
import { readNdjsonStream } from '@/frontend/utils/ndjsonReader';

const englishTranslator: Translator = (key, values) => translate('en', key, values);

/**
 * Drive one of the git route's streaming actions (`installStream` / `buildStream`, #65),
 * forwarding each stdout/stderr chunk to `onOutput` as it arrives and resolving with the
 * final result.
 *
 * Returns `null` when the stream is unavailable (network error, non-OK response, or a
 * body that could not be streamed because a proxy buffered it) so callers can gracefully
 * fall back to the non-streaming request.
 */
async function streamGitCommand(
  body: Record<string, unknown>,
  onOutput: (chunk: string) => void
): Promise<{ success: boolean; output: string } | null> {
  try {
    const response = await fetch('/api/git', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      return null;
    }

    let result: { success: boolean; output: string } | null = null;
    await readNdjsonStream(response, (event) => {
      if (event.type === 'stdout' || event.type === 'stderr') {
        onOutput(event.data);
      } else if (event.type === 'result') {
        result = { success: event.success, output: event.commandOutput ?? '' };
      }
    });

    return result;
  } catch (error) {
    console.error('Error streaming git command:', error);
    return null;
  }
}

export const installDependencies = async (
  serverPath: string,
  installCommand: string,
  onOutput?: (chunk: string) => void,
  t: Translator = englishTranslator
): Promise<{
  success: boolean;
  message: MessageState;
  output?: string;
}> => {
  // Streaming path (#65): fill the console live while the install runs. Falls through to
  // the non-streaming request below if the stream is unavailable.
  if (onOutput) {
    const streamed = await streamGitCommand(
      { action: 'installStream', savePath: serverPath, installCommand },
      onOutput
    );
    if (streamed) {
      return {
        success: streamed.success,
        message: streamed.success
          ? { type: 'success', text: t('mcp.build.installReady') }
          : { type: 'error', text: t('mcp.build.installContinue') },
        output: streamed.output || t('mcp.build.noInstallOutput'),
      };
    }
  }

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
      throw new Error(result.error || t('mcp.local.messages.installFailed'));
    }

    return {
      success: true,
      message: {
        type: 'success',
        text: t('mcp.build.installReady')
      },
      output: result.commandOutput || t('mcp.build.noInstallOutput')
    };
  } catch (error) {
    console.error('Error installing dependencies:', error);

    return {
      success: false,
      message: {
        type: 'error',
        text: t('mcp.build.installError', { error: (error as Error).message || t('mcp.server.unknownError') })
      },
      output: error instanceof Response ? await error.text() : (error as any)?.message || t('mcp.server.unknownError')
    };
  }
};

export const buildServer = async (
  serverPath: string,
  buildCommand: string,
  onOutput?: (chunk: string) => void,
  t: Translator = englishTranslator
): Promise<{
  success: boolean;
  message: MessageState;
  output?: string;
}> => {
  // Streaming path (#65): fill the console live while the build runs. Falls through to
  // the non-streaming request below if the stream is unavailable.
  if (onOutput) {
    const streamed = await streamGitCommand(
      { action: 'buildStream', savePath: serverPath, buildCommand },
      onOutput
    );
    if (streamed) {
      return {
        success: streamed.success,
        message: streamed.success
          ? { type: 'success', text: t('mcp.build.serverBuilt') }
          : { type: 'error', text: t('mcp.build.serverFailed') },
        output: streamed.output || t('mcp.build.noBuildOutput'),
      };
    }
  }

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
      throw new Error(result.error || t('mcp.build.serverFailed'));
    }

    return {
      success: true,
      message: {
        type: 'success',
        text: t('mcp.build.serverBuilt')
      },
      output: result.commandOutput || t('mcp.build.noBuildOutput')
    };
  } catch (error) {
    console.error('Error building server:', error);

    return {
      success: false,
      message: {
        type: 'error',
        text: t('mcp.build.serverError', { error: (error as Error).message || t('mcp.server.unknownError') })
      },
      output: error instanceof Response ? await error.text() : (error as any)?.message || t('mcp.server.unknownError')
    };
  }
};
