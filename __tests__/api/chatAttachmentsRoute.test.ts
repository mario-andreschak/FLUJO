import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';

const loadItemMock = jest.fn();

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));
jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T,>(handler: T): T => handler,
}));
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
}));

import { GET, POST } from '@/app/api/chat/attachments/route';

const MiB = 1024 * 1024;

function upload(name: string, bytes: Uint8Array, type = ''): NextRequest {
  const query = new URLSearchParams({ name, type });
  return new Request(`http://localhost:4200/api/chat/attachments?${query.toString()}`, {
    method: 'POST',
    headers: { host: 'localhost:4200', 'content-type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  }) as unknown as NextRequest;
}

describe('/api/chat/attachments (#1224)', () => {
  beforeEach(() => {
    loadItemMock.mockReset().mockResolvedValue(undefined);
  });

  it('reports the limits in force and this computer\'s defaults', async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: true }, chatAttachments: { maxFileMegabytes: 2, maxPages: 5 } });
    const response = await GET();
    const body = await response.json();
    expect(body.limits).toMatchObject({ maxFileBytes: 2 * MiB, maxPages: 5, maxTextCharacters: 400_000 });
    expect(body.defaults.defaultMaxFileBytes).toBeGreaterThanOrEqual(16 * MiB);
    expect(body.defaults.maxInlineBytes).toBeGreaterThan(0);
  });

  it('extracts the text of an uploaded document', async () => {
    const bytes = await readFile(path.join(process.cwd(), '__tests__', 'fixtures', 'chat-attachments', 'sample.docx'));
    const response = await POST(upload('sample.docx', bytes));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe('text');
    expect(body.note).toEqual({ code: 'text-extracted', values: { format: 'Word document' } });
    expect(body.text).toContain('# Garden plan');
  });

  it('answers a file over the limit with a note the chat can show, without reading it all', async () => {
    loadItemMock.mockResolvedValue({ speech: { enabled: true }, chatAttachments: { maxFileMegabytes: 1 } });
    const response = await POST(upload('big.zip', new Uint8Array(MiB + 1)));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ kind: 'note', note: { code: 'too-large', values: { limit: MiB } } });
  });

  it('keeps working with defaults when the settings cannot be read', async () => {
    loadItemMock.mockRejectedValue(new Error('locked'));
    const response = await POST(upload('notes.bin', new Uint8Array([0, 1, 2, 3])));
    await expect(response.json()).resolves.toEqual({ kind: 'note', note: { code: 'name-only' } });
  });
});
