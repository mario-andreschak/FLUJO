/**
 * `shell_info` discovery tool for the built-in `bash` MCP server (issue #364):
 * the model must be able to learn which shells/interpreters exist instead of
 * finding out through failed commands.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn().mockResolvedValue([]),
}));

import {
  bashToolDefinitions,
  bashCallTool,
  collectShellInfo,
  _resetBashShellCacheForTests,
} from '@/backend/services/mcp/internal/bashTools';

function parse(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

afterEach(() => {
  _resetBashShellCacheForTests();
});

describe('shell_info', () => {
  it('is exposed as a tool with an empty input schema', () => {
    const tool = bashToolDefinitions().find((t) => t.name === 'shell_info');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tool?.description).toMatch(/shell/i);
  });

  it('reports the platform, the resolved default shell, and per-shell availability', async () => {
    const payload = parse(await bashCallTool('shell_info', {}));
    expect(payload.platform).toBe(process.platform);
    expect(['pwsh', 'powershell', 'bash', 'cmd', 'sh']).toContain(payload.defaultShell);

    const shells = payload.shells as Array<{ shell: string; available: boolean; path: string | null }>;
    expect(shells.map((entry) => entry.shell)).toEqual(['pwsh', 'powershell', 'bash', 'cmd', 'sh']);
    for (const entry of shells) {
      expect(typeof entry.available).toBe('boolean');
      if (entry.available) expect(typeof entry.path).toBe('string');
      else expect(entry.path).toBeNull();
    }
    // The shell that "default" resolves to must be reported as available.
    expect(shells.find((entry) => entry.shell === payload.defaultShell)?.available).toBe(true);

    const binaries = payload.binaries as Array<{ name: string; found: boolean }>;
    expect(binaries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['python3', 'node', 'git']));
    expect(binaries.find((entry) => entry.name === 'node')?.found).toBe(true);

    const notes = payload.notes as string[];
    expect(notes.join(' ')).toMatch(/merges stdout and stderr/);
  });

  it('caches the probe result and forgets it on the test reset hook', () => {
    const first = collectShellInfo();
    expect(collectShellInfo()).toBe(first);
    _resetBashShellCacheForTests();
    expect(collectShellInfo()).not.toBe(first);
  });
});
