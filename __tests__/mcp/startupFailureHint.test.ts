import { findStartupFailureHint } from '@/utils/mcp/startupFailureHint';
import { handleRun } from '@/frontend/components/mcp/MCPServerManager/Modals/ServerModal/tabs/ConfigureTab/utils/formHandlers';
import { mcpService } from '@/frontend/services/mcp';
import type { MCPStdioConfig } from '@/shared/types/mcp/mcp';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: { testConnectionStreaming: jest.fn() },
}));

// Real diagnostics, captured from Python 3.13 and Node.js 22 (Windows) and from
// the Linux reproduction in issue #518.
const PYTHON_SCRIPT_MISSING_WINDOWS =
  "C:\\Python313\\python.exe: can't open file 'C:\\\\srv\\\\weather\\\\server.py': [Errno 2] No such file or directory";
const PYTHON_SCRIPT_MISSING_LINUX =
  "/usr/bin/python3: can't open file '/workspace/fastmcp-review-followup/does-not-exist.py': [Errno 2] No such file or directory";
const PYTHON_PACKAGE_MISSING = [
  'Traceback (most recent call last):',
  '  File "C:\\srv\\weather\\server.py", line 1, in <module>',
  '    from fastmcp import FastMCP',
  "ModuleNotFoundError: No module named 'fastmcp'",
].join('\n');
const PYTHON_RUN_MODULE_MISSING = 'C:\\Program Files\\Python313\\python.exe: No module named weather_server';
const NODE_ENTRY_MISSING = [
  'node:internal/modules/cjs/loader:1433',
  '  throw err;',
  '  ^',
  '',
  "Error: Cannot find module 'C:\\srv\\weather\\dist\\index.js'",
  '    at Function._resolveFilename (node:internal/modules/cjs/loader:1430:15) {',
  "  code: 'MODULE_NOT_FOUND',",
  '  requireStack: []',
  '}',
].join('\n');
const NODE_DEPENDENCY_MISSING = [
  "Error: Cannot find module '@modelcontextprotocol/sdk/server/index.js'",
  'Require stack:',
  '- /srv/weather/dist/index.js',
  "  code: 'MODULE_NOT_FOUND',",
].join('\n');
const NODE_ESM_PACKAGE_MISSING =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /srv/weather/index.mjs";
const NODE_ESM_FILE_MISSING =
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/srv/weather/dist/tools.js' imported from /srv/weather/dist/index.js";

describe('findStartupFailureHint', () => {
  it.each([
    ['a missing Python script on Windows', PYTHON_SCRIPT_MISSING_WINDOWS, 'pythonScriptMissing', 'C:\\srv\\weather\\server.py'],
    ['a missing Python script on Linux', PYTHON_SCRIPT_MISSING_LINUX, 'pythonScriptMissing', '/workspace/fastmcp-review-followup/does-not-exist.py'],
    ['a missing Python package', PYTHON_PACKAGE_MISSING, 'pythonPackageMissing', 'fastmcp'],
    ['a missing module run with python -m', PYTHON_RUN_MODULE_MISSING, 'pythonPackageMissing', 'weather_server'],
    ['a missing Node.js entry file', NODE_ENTRY_MISSING, 'nodeFileMissing', 'C:\\srv\\weather\\dist\\index.js'],
    ['a missing scoped Node.js package', NODE_DEPENDENCY_MISSING, 'nodePackageMissing', '@modelcontextprotocol/sdk'],
    ['a missing Node.js package in an ES module', NODE_ESM_PACKAGE_MISSING, 'nodePackageMissing', 'express'],
    ['a missing Node.js file in an ES module', NODE_ESM_FILE_MISSING, 'nodeFileMissing', '/srv/weather/dist/tools.js'],
  ])('recognises %s', (_label, output, kind, target) => {
    expect(findStartupFailureHint(output)).toEqual({ kind, target });
  });

  it('never reports a Python failure as a Node.js module error', () => {
    for (const output of [PYTHON_SCRIPT_MISSING_WINDOWS, PYTHON_SCRIPT_MISSING_LINUX, PYTHON_PACKAGE_MISSING, PYTHON_RUN_MODULE_MISSING]) {
      expect(findStartupFailureHint(output)?.kind).toMatch(/^python/);
    }
  });

  it('returns null for output it does not recognise', () => {
    expect(findStartupFailureHint(undefined)).toBeNull();
    expect(findStartupFailureHint('')).toBeNull();
    expect(findStartupFailureHint('Connection timeout after 30000ms')).toBeNull();
    expect(findStartupFailureHint("TypeError: Cannot read properties of undefined (reading 'tools')")).toBeNull();
  });
});

describe('Test Run failure message for a local server', () => {
  const testConnectionStreaming = mcpService.testConnectionStreaming as jest.Mock;
  const config: MCPStdioConfig = {
    name: 'weather',
    transport: 'stdio',
    command: 'python',
    args: ['server.py'],
    env: {},
    disabled: false,
    rootPath: 'C:\\srv\\weather',
    _buildCommand: '',
    _installCommand: '',
  };

  async function runAndGetErrorText(stderr: string): Promise<string | undefined> {
    testConnectionStreaming.mockResolvedValueOnce({ success: false, error: stderr });
    const setMessage = jest.fn();
    await handleRun(config, '', '', jest.fn(), jest.fn(), jest.fn(), jest.fn(), setMessage, jest.fn());
    const errors = setMessage.mock.calls.map(([message]) => message).filter((message) => message?.type === 'error');
    return errors.at(-1)?.text;
  }

  it('names the missing Python script and points at Arguments', async () => {
    const text = await runAndGetErrorText(PYTHON_SCRIPT_MISSING_LINUX);
    expect(text).toBe(
      'Python could not find the script /workspace/fastmcp-review-followup/does-not-exist.py. ' +
      'Check the script path in Arguments (for example server.py) and the MCP server root path.',
    );
  });

  it('tells the user to install a missing Python package, not to fix paths', async () => {
    const text = await runAndGetErrorText(PYTHON_PACKAGE_MISSING);
    expect(text).toContain("Python could not load the module 'fastmcp'");
    expect(text).toContain('pip install or uv sync');
    expect(text).not.toMatch(/MODULE_NOT_FOUND|Node\.js/);
  });

  it('tells the user to install a missing Node.js package', async () => {
    const text = await runAndGetErrorText(NODE_DEPENDENCY_MISSING);
    expect(text).toContain("Node.js could not find the package '@modelcontextprotocol/sdk'");
    expect(text).toContain('Install dependencies');
  });

  it('keeps the generic message when the cause is not recognised', async () => {
    const text = await runAndGetErrorText('Connection timeout after 30000ms');
    expect(text).toBe('Connection test failed. See the console for details.');
  });
});
