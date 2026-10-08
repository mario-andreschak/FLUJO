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
    expect(content?._meta).toEqual({
      ui: { csp: {}, permissions: { clipboardWrite: {} }, prefersBorder: true },
    });
  });

  it('embeds xterm and uses only the dedicated owner-scoped terminal tools', () => {
    const html = terminalHtml();
    expect(html).toContain('new Terminal({');
    expect(html).toContain('new FitAddon.FitAddon()');
    for (const tool of ['open_terminal', 'terminal_read', 'terminal_write', 'terminal_resize', 'terminal_close', 'terminal_list']) {
      expect(html).toContain(`"${tool}"`);
    }
  });

  it('supports raw input, incremental output, resize, copy, and docked display mode', () => {
    const html = terminalHtml();
    expect(html).toContain('terminal.onData');
    expect(html).toContain('terminal.onResize');
    expect(html).toContain('navigator.clipboard.writeText');
    expect(html).toContain('data.chunk');
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
