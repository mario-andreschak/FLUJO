import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { assertOwnerStartup } from '@/backend/services/security/ownerStartup';
import { issueOwnerCredential, type OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { initializeNodeRuntime } from '@/instrumentation-node';
import { proxy } from '@/proxy';

const mockLayout = jest.fn(async () => undefined);
jest.mock('@/backend/services/workspace/migration', () => ({ ensureWorkspaceLayoutReady: () => mockLayout() }));
jest.mock('@/backend/mcpApps/sandboxServer', () => ({ startSandboxServer: jest.fn() }));
jest.mock('@/backend/init', () => ({ ensureAllWorkspacesInitialized: jest.fn(async () => undefined) }));
const keys = ['FLUJO_OWNER_AUTH_FILE', 'FLUJO_EXPOSURE_MODE', 'FLUJO_EXTRA_LOCAL_HOSTS',
  'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL', 'FLUJO_MCP_APP_HOST_ORIGINS', 'FLUJO_WORKER_MODE',
  'FLUJO_SNAPSHOT_CONTROL_TOKEN'] as const;
let saved: Record<string, string | undefined>;
let directory: string;
let filename: string;
let policy: OwnerPolicy;
beforeEach(() => {
  saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  mockLayout.mockClear();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-owner-startup-'));
  filename = path.join(directory, 'policy.json');
  const issued = issueOwnerCredential(['openai:read'], 10_000, 1000);
  policy = { schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] };
  persist();
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function persist() { fs.writeFileSync(filename, JSON.stringify(policy), { mode: 0o600 }); }
test('keeps unconfigured loopback legacy startup available', () => {
  expect(() => assertOwnerStartup(2000)).not.toThrow();
});
test.each(['network', 'public'])('refuses unauthenticated %s startup before layout or services', async mode => {
  process.env.FLUJO_EXPOSURE_MODE = mode;
  await expect(initializeNodeRuntime()).rejects.toThrow('Restart with FLUJO_EXPOSURE_MODE=localhost');
  expect(mockLayout).not.toHaveBeenCalled();
  const response = (await proxy(new NextRequest('http://localhost:4200/v1/models', { headers: { host: 'localhost:4200' } })));
  expect(response.status).toBe(503);
});
test.each(['network', 'public'])('admits %s with an active scoped policy at startup', mode => {
  process.env.FLUJO_EXPOSURE_MODE = mode;
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  expect(() => assertOwnerStartup(2000)).not.toThrow();
});
test.each(['empty', 'expired', 'future', 'revoked', 'corrupt', 'missing'])('refuses %s authority with a redacted recovery error', variant => {
  process.env.FLUJO_EXPOSURE_MODE = 'public';
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  if (variant === 'empty') policy.credentials = [];
  if (variant === 'revoked') policy.credentials[0].revokedAt = 1500;
  persist();
  if (variant === 'corrupt') fs.writeFileSync(filename, 'private-corrupt-policy-content');
  if (variant === 'missing') fs.unlinkSync(filename);
  const now = variant === 'expired' ? 10_000 : variant === 'future' ? 999 : 2000;
  expect(() => assertOwnerStartup(now)).toThrow('Owner authentication is required');
  try { assertOwnerStartup(now); } catch (error) {
    expect(String(error)).not.toContain(filename);
    expect(String(error)).not.toContain('private-corrupt-policy-content');
    expect(String(error)).not.toContain(policy.credentials[0]?.digest ?? 'private-never-present');
  }
});
test('does not use anonymous loopback fallback for explicitly broken owner configuration', () => {
  process.env.FLUJO_EXPOSURE_MODE = 'localhost';
  process.env.FLUJO_OWNER_AUTH_FILE = '';
  expect(() => assertOwnerStartup(2000)).toThrow('Owner authentication is required');
});
test.each(['FLUJO_EXTRA_LOCAL_HOSTS', 'FLUJO_MCP_APP_SANDBOX_PUBLIC_URL', 'FLUJO_MCP_APP_HOST_ORIGINS'])('legacy exposure via %s cannot bypass startup authentication', key => {
  process.env[key] = key === 'FLUJO_EXTRA_LOCAL_HOSTS' ? 'host.example' : 'https://host.example';
  expect(() => assertOwnerStartup(2000)).toThrow('Owner authentication is required');
});
test('worker startup requires its distinct bearer and does not inherit owner authority', () => {
  process.env.FLUJO_WORKER_MODE = '1';
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  expect(() => assertOwnerStartup(2000)).toThrow('Worker startup requires');
  process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'synthetic-worker-bearer';
  fs.writeFileSync(filename, 'broken-general-policy');
  expect(() => assertOwnerStartup(2000)).not.toThrow();
});
