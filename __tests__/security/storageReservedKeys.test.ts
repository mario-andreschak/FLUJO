import { NextRequest } from 'next/server';

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

const loadItemMock = jest.fn();
const saveItemMock = jest.fn();
const clearItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...(args as [])),
  saveItem: (...args: unknown[]) => saveItemMock(...(args as [])),
  clearItem: (...args: unknown[]) => clearItemMock(...(args as [])),
}));

import { DELETE, GET, POST } from '@/app/api/storage/route';

function request(method: string, key: string): NextRequest {
  const url = `http://localhost:4200/api/storage?key=${encodeURIComponent(key)}`;
  return new NextRequest(url, {
    method,
    headers: { host: 'localhost:4200', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ key, value: { replaced: true } }) } : {}),
  });
}

describe('generic storage reserved state-machine keys', () => {
  beforeEach(() => {
    loadItemMock.mockReset();
    saveItemMock.mockReset();
    clearItemMock.mockReset();
  });

  it.each(['planned_executions', 'pending_approvals', 'package_installs', 'history'])(
    'refuses raw GET/POST/DELETE access to %s',
    async (key) => {
      expect((await GET(request('GET', key))).status).toBe(400);
      expect((await POST(request('POST', key))).status).toBe(400);
      expect((await DELETE(request('DELETE', key))).status).toBe(400);
      expect(loadItemMock).not.toHaveBeenCalled();
      expect(saveItemMock).not.toHaveBeenCalled();
      expect(clearItemMock).not.toHaveBeenCalled();
    },
  );
});
