import { flujoBaseUrl, flujoRequest, toolRoute } from '../../mcp-servers/flujo/src/client';
import { MCP_SKILLS_SUPPORTED_REVISION as STANDALONE_SKILLS_REVISION } from '../../mcp-servers/flujo/src/skills';
import { MCP_SKILLS_SUPPORTED_REVISION as HOST_SKILLS_REVISION } from '@/shared/types/mcp';

describe('standalone flujo HTTP client', () => {
  const originalBaseUrl = process.env.FLUJO_BASE_URL;
  const originalFetch = global.fetch;
  const originalWorkerMode = process.env.FLUJO_WORKER_MODE;
  const originalWorkerToken = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.FLUJO_BASE_URL;
    else process.env.FLUJO_BASE_URL = originalBaseUrl;
    global.fetch = originalFetch;
    if (originalWorkerMode === undefined) delete process.env.FLUJO_WORKER_MODE;
    else process.env.FLUJO_WORKER_MODE = originalWorkerMode;
    if (originalWorkerToken === undefined) delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
    else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = originalWorkerToken;
    jest.restoreAllMocks();
  });

  it('uses the same frozen Skills protocol revision as the host', () => {
    expect(STANDALONE_SKILLS_REVISION).toBe(HOST_SKILLS_REVISION);
  });

  it('defaults to the standard local URL and honors a custom runtime URL', () => {
    delete process.env.FLUJO_BASE_URL;
    expect(flujoBaseUrl()).toBe('http://127.0.0.1:4200');
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4317/';
    expect(flujoBaseUrl()).toBe('http://127.0.0.1:4317');
  });

  it('maps every tool group to a narrow domain endpoint', () => {
    expect(toolRoute('execute_flow')).toBe('/api/mcp/flujo/flows');
    expect(toolRoute('propose_ui_action')).toBe('/api/mcp/flujo/flows');
    expect(toolRoute('restart_mcp_server')).toBe('/api/mcp/flujo/servers');
    expect(toolRoute('create_planned_execution')).toBe('/api/mcp/flujo/automation');
    expect(toolRoute('kv_set')).toBe('/api/mcp/flujo/state');
    expect(toolRoute('create_flow')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('suggest_tools_for_flow_step')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('apply_tools_to_flow_step')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('check_flow_plausibility')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('find_mcp_server')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('find_best_mcp_server')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('install_mcp_server')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('install_best_mcp_server')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('read_persona_composition')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('update_persona_composition')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('draft_generated_flow')).toBe('/api/mcp/flujo/authoring');
    expect(toolRoute('create_ticket_for_human')).toBe('/api/mcp/flujo/automation');
    expect(() => toolRoute('arbitrary_internal_dispatch')).toThrow('Unknown FLUJO tool');
  });

  it('uses FLUJO_BASE_URL and preserves MCP result shapes', async () => {
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4567';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'done' }] }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(flujoRequest('callTool', {
      name: 'execute_flow',
      args: { flow: 'demo', input: 'hello' },
    })).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/api/mcp/flujo/flows',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    );
  });

  it('surfaces intentional API errors without leaking response bodies', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 423,
      text: async () => JSON.stringify({ error: 'Storage is locked' }),
    }) as typeof fetch;

    await expect(flujoRequest('listTools')).rejects.toThrow('Storage is locked');
  });

  it('authenticates internal worker requests and refuses to send that token off-host', async () => {
    process.env.FLUJO_WORKER_MODE = '1';
    process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-worker-token';
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4200';
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"tools":[]}' });
    global.fetch = fetchMock as typeof fetch;
    await flujoRequest('listTools');
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer synthetic-worker-token' }),
    }));
    fetchMock.mockClear();
    process.env.FLUJO_BASE_URL = 'https://original-host.example';
    await expect(flujoRequest('listTools')).rejects.toThrow('loopback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates standalone Skills responses before forwarding them', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        resultType: 'complete',
        skills: [{
          uri: 'skill://pdf-skill/SKILL.md',
          frontmatter: {
            name: 'pdf-skill',
            description: 'Process PDF files',
          },
          resources: [{
            uri: 'skill://pdf-skill/SKILL.md',
            digest: `sha256:${'a'.repeat(64)}`,
            size: 1,
          }],
        }],
      }),
    }) as typeof fetch;

    await expect(flujoRequest('listSkills')).resolves.toMatchObject({
      resultType: 'complete',
      skills: [{ uri: 'skill://pdf-skill/SKILL.md' }],
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        resultType: 'complete',
        skills: [{
          uri: 'skill://pdf-skill/SKILL.md',
          frontmatter: {
            name: 'pdf-skill',
            description: 'Process PDF files',
          },
          resources: [{
            uri: 'skill://pdf-skill/SKILL.md',
            digest: 'sha256:INVALID',
            size: 1,
          }],
        }],
      }),
    }) as typeof fetch;
    await expect(flujoRequest('listSkills')).rejects.toThrow(/digest/);
  });

  it('forwards and returns resources/list cursors', async () => {
    process.env.FLUJO_BASE_URL = 'http://127.0.0.1:4567';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        resources: [{ uri: 'flujo://run/c/r' }],
        resourceTemplates: [],
        nextCursor: 'next-page',
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(flujoRequest('listResources', { cursor: 'previous page' })).resolves.toEqual({
      resources: [{ uri: 'flujo://run/c/r' }],
      nextCursor: 'next-page',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/api/mcp/flujo/resources?cursor=previous%20page',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
