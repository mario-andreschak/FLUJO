/**
 * Tests for the built-in `bash` MCP server (issue #170): foreground run
 * (output/exit code, non-zero exit, timeout kill) and background sessions
 * (start → wait → result, kill a long runner, unknown-session errors).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { bashToolDefinitions, bashCallTool, _resetBashSessionsForTests } from '@/backend/services/mcp/internal/bashTools';

function text(r: CallToolResult): string {
  const first = r.content[0] as { text: string };
  return first.text;
}
function parse(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(text(r));
}

const isWin = process.platform === 'win32';

afterEach(() => {
  _resetBashSessionsForTests();
});

describe('bash tool definitions', () => {
  it('exposes foreground run + background session tools', () => {
    const names = bashToolDefinitions().map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['run', 'start', 'status', 'wait', 'write_stdin', 'kill', 'list_sessions'])
    );
  });
});

describe('bash run (foreground)', () => {
  it('runs a command and returns its output + exit code', async () => {
    const r = await bashCallTool('run', { command: 'echo hello-bash' });
    expect(r.isError).toBeUndefined();
    const out = parse(r);
    expect(out.output as string).toContain('hello-bash');
    expect(out.exitCode).toBe(0);
  });

  it('reports a non-zero exit as an error result', async () => {
    const r = await bashCallTool('run', { command: 'exit 3' });
    expect(r.isError).toBe(true);
    expect(parse(r).exitCode).toBe(3);
  });

  it('requires a command', async () => {
    const r = await bashCallTool('run', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('command');
  });

  it('kills a command that exceeds the timeout', async () => {
    const command = isWin ? 'ping -n 6 127.0.0.1 > NUL' : 'sleep 5';
    const r = await bashCallTool('run', { command, timeout: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('timedOut');
  }, 20000);

  it('normalizes CRLF to LF when requested', async () => {
    const r = await bashCallTool('run', { command: 'echo hi', normalizeNewlines: true });
    expect(text(r)).not.toContain('\r');
  });
});

describe('bash background sessions', () => {
  it('starts a session, waits for it, and reads the result', async () => {
    const start = parse(await bashCallTool('start', { command: 'echo bg-done' }));
    expect(start.sessionId).toBeTruthy();
    const waited = parse(await bashCallTool('wait', { sessionId: start.sessionId as string, timeout: 10 }));
    expect(waited.running).toBe(false);
    expect(waited.output as string).toContain('bg-done');

    const list = parse(await bashCallTool('list_sessions', {}));
    const ids = (list.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(ids).toContain(start.sessionId);
  }, 20000);

  it('kills a long-running background session', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
    const start = parse(await bashCallTool('start', { command }));
    const killed = parse(await bashCallTool('kill', { sessionId: start.sessionId as string }));
    expect(killed.killed).toBe(true);
    const waited = parse(await bashCallTool('wait', { sessionId: start.sessionId as string, timeout: 10 }));
    expect(waited.running).toBe(false);
  }, 25000);

  it('errors on an unknown session id', async () => {
    const r = await bashCallTool('status', { sessionId: 'does-not-exist' });
    expect(r.isError).toBe(true);
  });
});
