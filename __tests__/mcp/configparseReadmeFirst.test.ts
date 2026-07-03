/**
 * Regression tests for repository config auto-detection (parseRepositoryConfig).
 *
 * 1) The README's explicit mcpServers block must take precedence over
 *    language-specific filesystem heuristics, so the GitHub-clone auto-fill and
 *    the Local Server tab's "Parse README" button produce the same config.
 *    (duckduckgo-mcp-server: the README documents `uvx duckduckgo-mcp-server`,
 *    but the Python parser used to win with a broken pip-based setup.)
 *
 * 2) The Python fallback must never install into the system Python:
 *    `uv pip install ... --system` fails with "Access is denied" (os error 5)
 *    on Windows because writing to the global site-packages needs admin rights.
 */
import { parseRepositoryConfig } from '@/utils/mcp/configparse';
import { parseServerConfig } from '@/utils/mcp/parseServerConfig';
import { MCPStdioConfig } from '@/shared/types/mcp/mcp';

const README_WITH_CONFIG = `
# DuckDuckGo MCP server

## Quickstart

\`\`\`json
{
    "mcpServers": {
        "ddg-search": {
            "command": "uvx",
            "args": ["duckduckgo-mcp-server"]
        }
    }
}
\`\`\`
`;

const README_PLAIN = '# Some Python server\n\nSee the docs.\n';

const PYPROJECT = `
[project]
name = "duckduckgo-mcp-server"
version = "0.5.0"
`;

/** Serve a fake repo filesystem through the /api/git readFile endpoint. */
function mockRepoFiles(files: Record<string, string>) {
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const fileName = String(body.savePath ?? '').replace(/^repo\//, '');
    if (body.action === 'readFile' && fileName in files) {
      return {
        ok: true,
        json: async () => ({ success: true, content: files[fileName] })
      };
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }) as unknown as typeof fetch;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseRepositoryConfig: README explicit config wins over language heuristics', () => {
  it('uses the mcpServers block from the README even when pyproject.toml exists', async () => {
    mockRepoFiles({
      'README.md': README_WITH_CONFIG,
      'pyproject.toml': PYPROJECT
    });

    const result = await parseRepositoryConfig({
      repoPath: 'repo',
      repoName: 'duckduckgo-mcp-server'
    });

    expect(result.detected).toBe(true);
    expect(result.foundExplicitConfig).toBe(true);
    expect(result.runCommand).toBe('uvx');
    expect(result.args).toEqual(['duckduckgo-mcp-server']);
    expect((result.config as Partial<MCPStdioConfig>)?.command).toBe('uvx');
    // The README documents a package-runner setup; no install step must be forced
    expect(result.installCommand ?? '').not.toContain('--system');
  });

  it('falls back to the Python parser when the README has no explicit config', async () => {
    mockRepoFiles({
      'README.md': README_PLAIN,
      'pyproject.toml': PYPROJECT
    });

    const result = await parseRepositoryConfig({
      repoPath: 'repo',
      repoName: 'duckduckgo-mcp-server'
    });

    expect(result.detected).toBe(true);
    expect(result.language).toBe('python');
    // Installs into a project-local .venv, never the system Python
    expect(result.installCommand).toBe('uv sync');
    // Runs inside that .venv via uv
    expect(result.runCommand).toBe('uv');
    expect(result.args).toEqual(['run', 'python', '-m', 'duckduckgo_mcp_server']);
  });

  it('uses uv venv + entry point for requirements.txt-only repositories', async () => {
    mockRepoFiles({
      'README.md': README_PLAIN,
      'requirements.txt': 'httpx\n',
      'main.py': 'print("hi")\n'
    });

    const result = await parseRepositoryConfig({
      repoPath: 'repo',
      repoName: 'some-server'
    });

    expect(result.language).toBe('python');
    expect(result.installCommand).toBe('uv venv && uv pip install -r requirements.txt');
    expect(result.installCommand).not.toContain('--system');
    expect(result.runCommand).toBe('uv');
    expect(result.args).toEqual(['run', 'python', 'main.py']);
  });
});

describe('parseServerConfig: foundExplicitConfig flag', () => {
  it('is true when an mcpServers block is present', () => {
    const parsed = parseServerConfig(README_WITH_CONFIG, false, 'duckduckgo-mcp-server');
    expect(parsed.foundExplicitConfig).toBe(true);
    const stdioConfig = parsed.config as Partial<MCPStdioConfig>;
    expect(stdioConfig.command).toBe('uvx');
    expect(stdioConfig.args).toEqual(['duckduckgo-mcp-server']);
  });

  it('is false for loose commands scraped from prose', () => {
    const parsed = parseServerConfig('Run the server:\n```bash\npython main.py\n```\n', false);
    expect(parsed.foundExplicitConfig).toBe(false);
  });
});
