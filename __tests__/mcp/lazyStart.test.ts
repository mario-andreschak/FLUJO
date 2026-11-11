import { resolveLazyStart } from '@/backend/services/mcp/lazyStart';

let settings: unknown;
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (_key: string, fallback: unknown) => settings ?? fallback),
}));

describe('resolveLazyStart', () => {
  const original = process.env.FLUJO_MCP_LAZY_START;
  beforeEach(() => { delete process.env.FLUJO_MCP_LAZY_START; settings = undefined; });
  afterAll(() => {
    if (original === undefined) delete process.env.FLUJO_MCP_LAZY_START;
    else process.env.FLUJO_MCP_LAZY_START = original;
  });

  it('stays eager for existing installs with no setting', async () => {
    await expect(resolveLazyStart()).resolves.toBe(false);
    settings = { speech: { enabled: true } };
    await expect(resolveLazyStart()).resolves.toBe(false);
  });

  it('follows the setting', async () => {
    settings = { mcp: { lazyStart: true } };
    await expect(resolveLazyStart()).resolves.toBe(true);
  });

  it.each(['1', 'true', 'YES'])('lets %s in the environment turn it on', async value => {
    process.env.FLUJO_MCP_LAZY_START = value;
    await expect(resolveLazyStart()).resolves.toBe(true);
  });

  it('lets the environment turn it off against the setting', async () => {
    process.env.FLUJO_MCP_LAZY_START = '0';
    settings = { mcp: { lazyStart: true } };
    await expect(resolveLazyStart()).resolves.toBe(false);
  });

  it('treats a blank variable as not set', async () => {
    process.env.FLUJO_MCP_LAZY_START = '  ';
    settings = { mcp: { lazyStart: true } };
    await expect(resolveLazyStart()).resolves.toBe(true);
  });
});
