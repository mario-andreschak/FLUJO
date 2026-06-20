import {
  encodeToolName,
  buildToolNameMap,
  decodeToolName,
  isInternalToolName,
} from '@/backend/execution/flow/handlers/toolNamespace';
import { displayToolName } from '@/utils/shared/common';

const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('tool namespacing (#16)', () => {
  it('encodes OpenAI-valid names for hostile server/tool names', () => {
    // All of these pass FLUJO validateServerName today but break the legacy
    // _-_-_SERVER_-_-_TOOL scheme (spaces, dots, unicode, length > 64).
    const pairs = [
      { server: 'My File Server', tool: 'read_file' },
      { server: 'fs.local', tool: 'directory.tree' },
      { server: 'gitÜber', tool: 'create_or_update_file_in_a_long_repo_path_name_exceeding_limits' },
      { server: 'a'.repeat(120), tool: 'b'.repeat(120) },
    ];
    for (const { server, tool } of pairs) {
      const name = encodeToolName(server, tool);
      expect(name).toMatch(OPENAI_NAME);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  it('is deterministic', () => {
    expect(encodeToolName('s', 't')).toBe(encodeToolName('s', 't'));
  });

  it('round-trips via a map built from bound pairs', () => {
    const map = buildToolNameMap([
      { server: 'everything', tool: 'echo' },
      { server: 'fs', tool: 'read_file' },
    ]);
    const name = encodeToolName('everything', 'echo');
    expect(decodeToolName(name, map)).toEqual({ server: 'everything', tool: 'echo' });
  });

  it('decodes legacy _-_-_ names without a map (back-compat)', () => {
    expect(decodeToolName('_-_-_myserver_-_-_mytool')).toEqual({
      server: 'myserver',
      tool: 'mytool',
    });
  });

  it('returns null for undecodable names', () => {
    expect(decodeToolName('handoff_to_finish')).toBeNull();
    expect(decodeToolName('mcp_unknown_zzzz')).toBeNull();
  });

  it('classifies internal MCP tools by map or legacy scheme', () => {
    const name = encodeToolName('s', 't');
    const map = buildToolNameMap([{ server: 's', tool: 't' }]);
    expect(isInternalToolName(name, map)).toBe(true);
    expect(isInternalToolName('_-_-_s_-_-_t')).toBe(true); // legacy
    expect(isInternalToolName('handoff_to_x', map)).toBe(false);
    expect(isInternalToolName('some_external_tool', map)).toBe(false);
  });

  it('produces a friendly display name for both schemes', () => {
    expect(displayToolName('_-_-_server_-_-_read_file')).toBe('read_file');
    expect(displayToolName(encodeToolName('server', 'read_file'))).toBe('read_file');
    expect(displayToolName('handoff_to_finish')).toBe('handoff_to_finish');
  });
});
