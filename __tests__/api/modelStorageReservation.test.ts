import { NextRequest } from 'next/server';
import { POST, DELETE } from '@/app/api/storage/route';
import { StorageKey } from '@/shared/types/storage';
import { saveItem, clearItem } from '@/utils/storage/backend';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  saveItem: jest.fn(),
  clearItem: jest.fn(),
}));

it('reserves model writes and deletes for the coordinated model routes', async () => {
  const post = await POST(new NextRequest('http://localhost/api/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: StorageKey.MODELS, value: [] }),
  }));
  const deletion = await DELETE(new NextRequest(`http://localhost/api/storage?key=${StorageKey.MODELS}`, {
    method: 'DELETE',
  }));
  expect(post.status).toBe(400);
  expect(deletion.status).toBe(400);
  expect(saveItem).not.toHaveBeenCalled();
  expect(clearItem).not.toHaveBeenCalled();
});
