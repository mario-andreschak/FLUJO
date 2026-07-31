import {
  BASH_TERMINAL_APP_URI,
  bashListResources,
  bashReadResource,
} from '@/backend/services/mcp/internal/bashResources';

function terminalHtml(): string {
  const result = bashReadResource(BASH_TERMINAL_APP_URI);
  expect(result.success).toBe(true);
  const content = result.data?.contents?.[0];
  expect(content?.mimeType).toBe('text/html;profile=mcp-app');
  const html = content && 'text' in content ? content.text : undefined;
  expect(typeof html).toBe('string');
  return html as string;
}

describe('Bash terminal MCP App', () => {
  it('lists and reads one stable, sandbox-safe terminal resource', () => {
    expect(bashListResources().resources).toEqual([
      expect.objectContaining({
        uri: 'ui://bash/terminal',
        mimeType: 'text/html;profile=mcp-app',
      }),
    ]);
    const result = bashReadResource(BASH_TERMINAL_APP_URI);
    const content = result.data?.contents?.[0] as { _meta?: unknown } | undefined;
    expect(content?._meta).toEqual({ ui: { csp: {}, permissions: {} } });
  });

  it('uses textContent for shell output and only approved Bash session tools', () => {
    const html = terminalHtml();
    expect(html).toContain('outputEl.textContent = data.output');
    expect(html).not.toContain('outputEl.innerHTML');
    for (const tool of ['start', 'status', 'write_stdin', 'kill', 'list_sessions']) {
      expect(html).toContain(`"${tool}"`);
    }
  });

  it('documents the non-PTY contract and advertises docked display mode', () => {
    const html = terminalHtml();
    expect(html).toContain('Line-oriented console only');
    expect(html).toContain('Full-screen TTY apps');
    expect(html).toContain('availableDisplayModes:["inline","fullscreen","pip"]');
    expect(html).toContain('"ui/request-display-mode", { mode:"pip" }');
  });

  it('rejects unknown Bash resource URIs', () => {
    expect(bashReadResource('ui://bash/unknown')).toEqual(expect.objectContaining({
      success: false,
      statusCode: 404,
    }));
  });
});
