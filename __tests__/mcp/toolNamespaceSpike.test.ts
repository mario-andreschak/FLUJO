import { buildToolNameRegistry } from '@/backend/execution/flow/handlers/toolNamespace.spike';

// OpenAI function-name constraint.
const OPENAI_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('SPIKE: tool-namespace short-id registry (#16)', () => {
  it('encode/decode round-trips a normal pair', () => {
    const reg = buildToolNameRegistry([{ server: 'everything', tool: 'echo' }]);
    const name = reg.encode('everything', 'echo')!;
    expect(name).toBeTruthy();
    expect(reg.decode(name)).toEqual({ server: 'everything', tool: 'echo' });
  });

  it('produces OpenAI-valid names even for hostile server/tool names', () => {
    // These pass FLUJO's validateServerName today but break the current
    // `_-_-_SERVER_-_-_TOOL` scheme (spaces, dots, length, unicode).
    const pairs = [
      { server: 'My File Server', tool: 'read_file' },
      { server: 'fs.local', tool: 'directory.tree' },
      { server: 'gitÜber', tool: 'create_or_update_file_in_a_very_long_repository_path_name' },
      { server: 'a'.repeat(120), tool: 'b'.repeat(120) },
    ];
    const reg = buildToolNameRegistry(pairs);
    for (const { server, tool } of pairs) {
      const name = reg.encode(server, tool)!;
      expect(name).toMatch(OPENAI_NAME);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(reg.decode(name)).toEqual({ server, tool });
    }
  });

  it('is deterministic across separately-built registries (stable across requests)', () => {
    const a = buildToolNameRegistry([{ server: 's', tool: 't' }]);
    const b = buildToolNameRegistry([{ server: 's', tool: 't' }, { server: 'other', tool: 'x' }]);
    expect(a.encode('s', 't')).toBe(b.encode('s', 't'));
  });

  it('disambiguates distinct pairs that share a tool name', () => {
    const reg = buildToolNameRegistry([
      { server: 'serverA', tool: 'search' },
      { server: 'serverB', tool: 'search' },
    ]);
    const a = reg.encode('serverA', 'search')!;
    const b = reg.encode('serverB', 'search')!;
    expect(a).not.toBe(b);
    expect(reg.decode(a)).toEqual({ server: 'serverA', tool: 'search' });
    expect(reg.decode(b)).toEqual({ server: 'serverB', tool: 'search' });
  });

  it('returns null for unknown names (no false decode)', () => {
    const reg = buildToolNameRegistry([{ server: 's', tool: 't' }]);
    expect(reg.decode('handoff')).toBeNull();
    expect(reg.decode('mcp_does_not_exist_zzzz')).toBeNull();
  });
});
