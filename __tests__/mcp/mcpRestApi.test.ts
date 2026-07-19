/**
 * Regression test for the MCP REST API.
 *
 * The MCP HTTP surface was reworked from an action-based dispatcher
 * (`?action=loadConfigs|listTools|status`, `POST { action: 'updateConfig' | ... }`)
 * into standard REST resource routing. Server configs are nested under `/servers` so the
 * `[name]` segment has no static siblings and no server name can collide with the
 * `cancel` / `test-connection` action routes:
 *
 *   GET    /api/mcp/servers                       -> list
 *   POST   /api/mcp/servers                       -> create (body = config, 409 on duplicate)
 *   GET    /api/mcp/servers/{name}                -> read
 *   PUT    /api/mcp/servers/{name}                -> update (partial body is merged)
 *   DELETE /api/mcp/servers/{name}                -> delete
 *   GET    /api/mcp/servers/{name}/status         -> live connection status
 *   GET    /api/mcp/servers/{name}/tools          -> list tools
 *   POST   /api/mcp/servers/{name}/tools/{tool}   -> invoke a tool
 *   POST   /api/mcp/test-connection               -> test an (unsaved) config
 *
 * These tests drive the real route handlers + backend service against in-memory storage.
 * They cover the CRUD cycle, status codes, name validation, and that a server named
 * `cancel` is handled as an ordinary resource. They do NOT exercise Next's static-vs-
 * dynamic route precedence (handlers are imported directly) — the `/servers` nesting makes
 * that precedence moot anyway. Fixtures are `disabled: true` so the service never tries to
 * spawn a real server process.
 */
import type { MCPServerConfig, MCPStdioConfig } from '@/shared/types/mcp';

// In-memory storage so the backend service never touches disk.
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
}));

// Global-variable resolution touches the global var subsystem; identity keeps tests hermetic.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) => v),
}));

import { GET as listServers, POST as createServer } from '@/app/api/mcp/servers/route';
import { GET as getServer, PUT as updateServer, DELETE as deleteServer } from '@/app/api/mcp/servers/[name]/route';
import { GET as getStatus } from '@/app/api/mcp/servers/[name]/status/route';
import { GET as getTools } from '@/app/api/mcp/servers/[name]/tools/route';
import { POST as callTool } from '@/app/api/mcp/servers/[name]/tools/[toolName]/route';
import { POST as testConnection } from '@/app/api/mcp/test-connection/route';
import { makeLocalRequest } from '../utils/localRequest';

// The handlers call request.json() and the fail-closed origin guard (#142) reads
// Host/Origin; makeLocalRequest supplies both so the guard treats it as local.
const req = (body?: unknown) => makeLocalRequest({ body });
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const toolCtx = (name: string, toolName: string) => ({ params: Promise.resolve({ name, toolName }) });

const serverFixture = (over: Partial<MCPStdioConfig> = {}): MCPServerConfig => ({
  name: 'srv1',
  transport: 'stdio',
  command: 'echo',
  args: ['hello'],
  env: {},
  disabled: true,
  autoApprove: [],
  rootPath: '',
  _buildCommand: '',
  _installCommand: '',
  ...over,
} as MCPStdioConfig);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

// The list always contains FLUJO's synthetic built-in server; these tests are
// about the USER-configured servers, so assertions filter it out.
const userServers = (list: MCPServerConfig[]) => list.filter((c) => !c.builtIn);

describe('MCP REST API', () => {
  it('GET /api/mcp/servers returns only the built-in servers initially', async () => {
    const res = await listServers();
    expect(res.status).toBe(200);
    const list = (await res.json()) as MCPServerConfig[];
    expect(userServers(list)).toEqual([]);
    // Issue #170: FLUJO now ships three built-in servers.
    expect(list.map((c) => c.name)).toEqual(['flujo', 'filesystem', 'bash']);
    expect(list.every((c) => c.builtIn)).toBe(true);
  });

  it('POST /api/mcp/servers creates a server (201) and returns the config', async () => {
    const res = await createServer(req(serverFixture()));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe('srv1');
    expect(created.command).toBe('echo');
  });

  it('POST /api/mcp/servers rejects a missing name with 400', async () => {
    const res = await createServer(req(serverFixture({ name: '' })));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toHaveProperty('error');
  });

  it('POST /api/mcp/servers rejects a duplicate name with 409', async () => {
    await createServer(req(serverFixture()));
    const res = await createServer(req(serverFixture({ command: 'other' })));
    expect(res.status).toBe(409);
  });

  it('GET /api/mcp/servers/{name} reads a server, 404 when missing', async () => {
    await createServer(req(serverFixture()));

    const ok = await getServer(req(), ctx('srv1'));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ name: 'srv1', command: 'echo' });

    const missing = await getServer(req(), ctx('nope'));
    expect(missing.status).toBe(404);
  });

  it('PUT /api/mcp/servers/{name} merges a partial body onto the stored config', async () => {
    await createServer(req(serverFixture()));

    const res = await updateServer(req({ autoApprove: ['toolX'] }), ctx('srv1'));
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.autoApprove).toEqual(['toolX']);
    // Fields not present in the partial body are preserved.
    expect(updated.command).toBe('echo');
    expect(updated.disabled).toBe(true);
  });

  it('PUT /api/mcp/servers/{name} returns 404 for an unknown server', async () => {
    const res = await updateServer(req({ autoApprove: [] }), ctx('ghost'));
    expect(res.status).toBe(404);
  });

  it('DELETE /api/mcp/servers/{name} removes the server, 404 when missing', async () => {
    await createServer(req(serverFixture()));

    const del = await deleteServer(req(), ctx('srv1'));
    expect(del.status).toBe(200);
    await expect(del.json()).resolves.toEqual({ success: true });

    const afterList = (await (await listServers()).json()) as MCPServerConfig[];
    expect(userServers(afterList)).toEqual([]);

    const delAgain = await deleteServer(req(), ctx('srv1'));
    expect(delAgain.status).toBe(404);
  });

  it('GET /api/mcp/servers/{name}/status reports a disabled server as disconnected', async () => {
    await createServer(req(serverFixture()));
    const res = await getStatus(req(), ctx('srv1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'disconnected' });
  });

  it('GET /api/mcp/servers/{name}/tools returns an empty list with an error when not connected', async () => {
    await createServer(req(serverFixture()));
    const res = await getTools(req(), ctx('srv1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toEqual([]);
    expect(body.error).toBeTruthy();
  });

  it('POST /api/mcp/servers/{name}/tools/{toolName} rejects a request without args (400)', async () => {
    await createServer(req(serverFixture()));
    const res = await callTool(req({}), toolCtx('srv1', 'doThing'));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toHaveProperty('error');
  });

  it('POST /api/mcp/test-connection rejects an invalid config (400)', async () => {
    const res = await testConnection(req({ name: 'x' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  // --- Built-in internal server: present, protected, reserved name ---

  it('protects the built-in server: no create under its name, no edit, no delete', async () => {
    // POST under the reserved name collides with the synthetic entry -> 409.
    const create = await createServer(req(serverFixture({ name: 'flujo' })));
    expect(create.status).toBe(409);

    // Editing non-toggle fields is refused as forbidden, and so is DELETE.
    const put = await updateServer(req({ command: 'evil' }), ctx('flujo'));
    expect(put.status).toBe(403);
    const del = await deleteServer(req(), ctx('flujo'));
    expect(del.status).toBe(403);

    // Issue #170: toggling only the `disabled` flag IS allowed (200).
    const toggle = await updateServer(req({ disabled: true }), ctx('flujo'));
    expect(toggle.status).toBe(200);

    // Renaming another server onto the reserved name is a name collision.
    await createServer(req(serverFixture({ name: 'victim' })));
    const rename = await updateServer(req({ name: 'flujo' }), ctx('victim'));
    expect(rename.status).toBe(409);
  });

  it('reports the built-in server as connected and lists its tools without a process', async () => {
    const status = await getStatus(req(), ctx('flujo'));
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ status: 'connected' });

    const tools = await getTools(req(), ctx('flujo'));
    expect(tools.status).toBe(200);
    const body = await tools.json();
    expect(body.error).toBeUndefined();
    const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_flow', 'execute_flow', 'list_mcp_servers']));
  });

  // --- Name handling: the reason for the /servers nesting + validation ---

  it('handles a server literally named "cancel" as an ordinary resource', async () => {
    // Under the old flat scheme this name was shadowed by the static /api/mcp/cancel route.
    const created = await createServer(req(serverFixture({ name: 'cancel' })));
    expect(created.status).toBe(201);

    const read = await getServer(req(), ctx('cancel'));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ name: 'cancel' });

    const del = await deleteServer(req(), ctx('cancel'));
    expect(del.status).toBe(200);
  });

  it('allows a name containing spaces (encodes fine in a URL)', async () => {
    const res = await createServer(req(serverFixture({ name: 'my server' })));
    expect(res.status).toBe(201);
    const read = await getServer(req(), ctx('my server'));
    expect(read.status).toBe(200);
  });

  it('rejects names that break URL routing on create (400)', async () => {
    for (const name of ['a/b', 'a\\b', '..', '.']) {
      const res = await createServer(req(serverFixture({ name })));
      expect(res.status).toBe(400);
    }
  });

  it('rejects a rename to an invalid name on PUT (400)', async () => {
    await createServer(req(serverFixture()));
    const res = await updateServer(req({ name: 'a/b' }), ctx('srv1'));
    expect(res.status).toBe(400);
  });

  // --- Rename: addressed by the OLD name (path), the NEW name lives in the body ---

  it('PUT renames a server in place — no duplicate, old name removed', async () => {
    await createServer(req(serverFixture({ name: 'old' })));

    const res = await updateServer(req({ name: 'new' }), ctx('old'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ name: 'new', command: 'echo' });

    // Exactly one user server remains, under the new name — the rename did not duplicate it.
    const list = await (await listServers()).json();
    expect(userServers(list as MCPServerConfig[]).map((c) => c.name)).toEqual(['new']);

    // The old name is gone; the new name reads back the carried-over config.
    expect((await getServer(req(), ctx('old'))).status).toBe(404);
    const renamed = await getServer(req(), ctx('new'));
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ name: 'new', command: 'echo' });
  });

  it('PUT rejects a rename onto an existing name (409) and keeps both servers intact', async () => {
    await createServer(req(serverFixture({ name: 'a' })));
    await createServer(req(serverFixture({ name: 'b', command: 'bbb' })));

    const res = await updateServer(req({ name: 'b' }), ctx('a'));
    expect(res.status).toBe(409);

    // Neither server was lost or clobbered.
    const list = await (await listServers()).json();
    expect(userServers(list as MCPServerConfig[]).map((c) => c.name).sort()).toEqual(['a', 'b']);
    await expect(
      getServer(req(), ctx('b')).then((r) => r.json())
    ).resolves.toMatchObject({ command: 'bbb' });
  });
});
