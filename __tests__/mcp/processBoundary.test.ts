import path from 'node:path';
import {
  connectStdio,
  waitFor,
  type ProcessIdentity,
  type TrackedStdioClient,
} from './processBoundaryHarness';

jest.setTimeout(30_000);

const fixture = path.resolve(
  process.cwd(),
  '__tests__',
  'mcp',
  'fixtures',
  'processBoundaryServer.mjs',
);

let active: TrackedStdioClient | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

async function identity(client: TrackedStdioClient): Promise<ProcessIdentity> {
  const result = await client.client.callTool({ name: 'identity', arguments: {} });
  return result.structuredContent as unknown as ProcessIdentity;
}

describe('real stdio MCP process boundary', () => {
  it('negotiates capabilities, serves tools/resources, notifies, and exits cleanly', async () => {
    active = await connectStdio(fixture);

    expect(active.child.pid).toBeGreaterThan(0);
    expect(active.child.pid).not.toBe(process.pid);
    expect(active.client.getServerVersion()?.name).toBe('flujo-process-boundary-fixture');
    expect(active.client.getServerCapabilities()).toMatchObject({
      tools: {},
      resources: {},
      logging: {},
    });

    const tools = await active.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['identity']);
    const firstIdentity = await identity(active);
    expect(firstIdentity.pid).toBe(active.child.pid);
    expect(firstIdentity.parentPid).toBe(process.pid);
    expect(firstIdentity.token).toMatch(/^[0-9a-f-]{36}$/);

    const resources = await active.client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'fixture://identity', mimeType: 'application/json' }),
    ]));
    const templates = await active.client.listResourceTemplates();
    expect(templates.resourceTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({ uriTemplate: 'fixture://identity/{field}' }),
    ]));
    const read = await active.client.readResource({ uri: 'fixture://identity' });
    const identityResource = read.contents[0] as { text: string };
    expect(JSON.parse(identityResource.text)).toEqual(firstIdentity);

    await waitFor(
      () => active!.notifications,
      (notifications) => notifications.some((notification) =>
        (notification as { data?: { event?: string; token?: string } }).data?.event === 'initialized'
        && (notification as { data?: { token?: string } }).data?.token === firstIdentity.token),
      { description: 'fixture initialized notification' },
    );

    const child = active.child;
    await active.close();
    active = undefined;
    const exited = child.exitCode !== null || child.signalCode !== null;
    expect(exited).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  it('terminates on disable/close and restart reaches a fresh process identity', async () => {
    active = await connectStdio(fixture);
    const first = await identity(active);
    const firstChild = active.child;

    await active.close();
    active = undefined;
    expect(firstChild.exitCode).toBe(0);

    active = await connectStdio(fixture);
    const restarted = await identity(active);
    expect(restarted.pid).toBe(active.child.pid);
    expect(restarted.token).not.toBe(first.token);
  });
});
