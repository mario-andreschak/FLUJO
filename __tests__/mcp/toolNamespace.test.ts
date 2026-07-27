import {
  encodeToolName,
  buildToolNameMap,
  decodeToolName,
  isInternalToolName,
  hashSchema,
  assertToolIdentityFresh,
  type ToolIdentityService,
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

describe('tool identity / staleness guard (#255)', () => {
  it('hashSchema is stable regardless of key order and sensitive to changes', () => {
    const a = { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } };
    const b = { properties: { y: { type: 'number' }, x: { type: 'string' } }, type: 'object' };
    expect(hashSchema(a)).toBe(hashSchema(b));
    const c = { type: 'object', properties: { x: { type: 'number' } } };
    expect(hashSchema(a)).not.toBe(hashSchema(c));
    // undefined/null hash to a stable sentinel (not throwing).
    expect(hashSchema(undefined)).toBe(hashSchema(null));
  });

  // A stub MCP service implementing only what the guard reads.
  function makeSvc(opts: {
    hasClient?: boolean;
    generation?: number;
    schemaHash?: string;
  }): ToolIdentityService {
    return {
      getClient: () => (opts.hasClient === false ? undefined : {}),
      getClientGeneration: () => opts.generation ?? 0,
      getToolSchemaHash: () => opts.schemaHash,
    };
  }

  it('skips the check for legacy/synthetic tools carrying no identity', () => {
    const svc = makeSvc({ hasClient: false }); // even with no client, absent identity => ok
    const res = assertToolIdentityFresh('mcp_x_abc', { server: 's', tool: 't' }, svc);
    expect(res.ok).toBe(true);
  });

  it('passes when generation and schema hash match', () => {
    const svc = makeSvc({ generation: 3, schemaHash: 'HASH' });
    const res = assertToolIdentityFresh(
      'mcp_t_abc',
      { server: 's', tool: 't', clientGeneration: 3, schemaHash: 'HASH' },
      svc,
    );
    expect(res.ok).toBe(true);
  });

  it('fails when the server client is gone', () => {
    const svc = makeSvc({ hasClient: false, generation: 1 });
    const res = assertToolIdentityFresh(
      'mcp_t_abc',
      { server: 's', tool: 't', clientGeneration: 1 },
      svc,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no longer available/i);
  });

  it('fails on a client-generation mismatch (server reconnected)', () => {
    const svc = makeSvc({ generation: 4, schemaHash: 'HASH' });
    const res = assertToolIdentityFresh(
      'mcp_t_abc',
      { server: 's', tool: 't', clientGeneration: 3, schemaHash: 'HASH' },
      svc,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/re-registered|reconnected/i);
  });

  it('fails on a schema-hash mismatch (same generation)', () => {
    const svc = makeSvc({ generation: 3, schemaHash: 'NEWHASH' });
    const res = assertToolIdentityFresh(
      'mcp_t_abc',
      { server: 's', tool: 't', clientGeneration: 3, schemaHash: 'OLDHASH' },
      svc,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/schema/i);
  });

  it('does not fail on schema when the current hash is unknown', () => {
    const svc = makeSvc({ generation: 3, schemaHash: undefined });
    const res = assertToolIdentityFresh(
      'mcp_t_abc',
      { server: 's', tool: 't', clientGeneration: 3, schemaHash: 'OLDHASH' },
      svc,
    );
    expect(res.ok).toBe(true);
  });
});
