/**
 * POST /api/mcp/bundles (#1230): local callers only, form upload in, plain
 * words out, and the person's settings passed through untouched.
 */
import { NextRequest } from 'next/server';

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T>(handler: T) => handler,
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));

const mockReview = jest.fn();
const mockInstall = jest.fn();
jest.mock('@/backend/services/mcp/mcpb/install', () => ({
  reviewMcpbBundle: (...args: unknown[]) => mockReview(...args),
  installMcpbBundle: (...args: unknown[]) => mockInstall(...args),
}));
jest.mock('@/backend/services/accounts/hostAccess', () => {
  class HostAccessRequiredError extends Error {
    readonly status = 403;
  }
  return { HostAccessRequiredError };
});

import { POST } from '@/app/api/mcp/bundles/route';
import { McpbError } from '@/backend/services/mcp/mcpb/manifest';
import { HostAccessRequiredError } from '@/backend/services/accounts/hostAccess';

function request(fields: Record<string, string | Blob>, headers: Record<string, string> = { host: 'localhost:4200' }): NextRequest {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return new NextRequest('http://localhost:4200/api/mcp/bundles', { method: 'POST', body: form, headers });
}

const file = () => new Blob([Buffer.from('PK\u0003\u0004 bundle bytes')], { type: 'application/zip' });

beforeEach(() => {
  mockReview.mockReset();
  mockInstall.mockReset();
});

it('refuses a request from another website before reading the file', async () => {
  const response = await POST(request({ action: 'review', bundle: file() }, { host: 'localhost:4200', origin: 'https://evil.example' }));
  expect(response.status).toBe(403);
  expect(mockReview).not.toHaveBeenCalled();
});

it('reviews the uploaded bytes', async () => {
  mockReview.mockResolvedValue({ digest: 'd', manifestName: 'hello' });
  const response = await POST(request({ action: 'review', bundle: file() }));
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ digest: 'd' });
  const bytes = mockReview.mock.calls[0][0] as Buffer;
  expect(Buffer.isBuffer(bytes)).toBe(true);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
});

it('installs with the reviewed digest, name and settings', async () => {
  mockInstall.mockResolvedValue({ installed: true, serverName: 'hello', upgraded: false, version: '1.0.0' });
  const response = await POST(request({
    action: 'install',
    bundle: file(),
    reviewedDigest: 'abc',
    serverName: 'hello',
    userConfig: JSON.stringify({ api_key: 'secret', roots: ['/a', '/b'] }),
  }));
  expect(response.status).toBe(201);
  expect(mockInstall.mock.calls[0][0]).toMatchObject({
    reviewedDigest: 'abc',
    serverName: 'hello',
    userConfig: { api_key: 'secret', roots: ['/a', '/b'] },
  });
});

it('answers bundle problems with their words, code and fields', async () => {
  mockInstall.mockRejectedValue(new McpbError('Fill in "API key" before installing.', 'missing-config', 400, ['api_key']));
  const response = await POST(request({ action: 'install', bundle: file(), reviewedDigest: 'abc', serverName: 'hello', userConfig: '{}' }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: 'Fill in "API key" before installing.', code: 'missing-config', fields: ['api_key'] });
});

it('answers 403 when the person may not start programs on this computer', async () => {
  mockInstall.mockRejectedValue(new HostAccessRequiredError('local-mcp-server'));
  const response = await POST(request({ action: 'install', bundle: file(), reviewedDigest: 'abc', serverName: 'hello', userConfig: '{}' }));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: 'host-install-blocked' });
});

it('refuses settings that are not a JSON object', async () => {
  const response = await POST(request({ action: 'install', bundle: file(), reviewedDigest: 'abc', serverName: 'hello', userConfig: '[1,2]' }));
  expect(response.status).toBe(400);
  expect(mockInstall).not.toHaveBeenCalled();
});

it('refuses a body larger than the limit before reading it', async () => {
  const response = await POST(request({ action: 'review', bundle: file() }, { host: 'localhost:4200', 'content-length': String(2 * 1024 ** 3) }));
  expect(response.status).toBe(413);
  await expect(response.json()).resolves.toMatchObject({ code: 'too-large' });
  expect(mockReview).not.toHaveBeenCalled();
});

it('asks for a file when none was sent', async () => {
  const response = await POST(request({ action: 'review' }));
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ code: 'not-a-bundle' });
});
