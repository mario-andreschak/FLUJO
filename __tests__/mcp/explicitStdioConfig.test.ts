import { explicitStdioConfig, isPublishedPackageRunner } from '@/utils/mcp/explicitStdioConfig';

describe('explicit MCP configuration', () => {
  it('keeps nested env values, URLs, and arguments containing commas intact', () => {
    const result = explicitStdioConfig(JSON.stringify({ mcpServers: { computer: {
      command: 'uvx', args: ['mcp-virtual-computer', 'a,b'], env: {
        COMPUTER_ID: 'agent-workstation', URL: 'https://example.com/path',
        KEY: { value: '${global:KEY}', metadata: { isSecret: true } },
      },
    } } }));
    expect(result?.args).toEqual(['mcp-virtual-computer', 'a,b']);
    expect(result?.env).toEqual({ COMPUTER_ID: 'agent-workstation', URL: 'https://example.com/path',
      KEY: { value: '${global:KEY}', metadata: { isSecret: true } },
    });
  });

  it('selects the requested server when one block contains multiple servers', () => {
    expect(explicitStdioConfig(JSON.stringify({ mcpServers: {
      first: { command: 'uvx', args: ['first'] }, second: { command: 'uvx', args: ['second'] },
    } }), 'second')?.args).toEqual(['second']);
  });

  it('keeps source-build handling for local package paths', () => {
    expect(isPublishedPackageRunner('uvx', ['mcp-virtual-computer'])).toBe(true);
    expect(isPublishedPackageRunner('uvx', ['--from', '.', 'server'])).toBe(false);
    expect(isPublishedPackageRunner('npx', ['./local-server'])).toBe(false);
    expect(isPublishedPackageRunner('node', ['dist/server.js'])).toBe(false);
  });
});
