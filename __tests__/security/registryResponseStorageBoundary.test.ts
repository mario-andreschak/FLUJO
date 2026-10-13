import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageKey } from '@/shared/types/storage';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

const mockSignup = jest.fn();
jest.mock('@/backend/utils/packageRegistryClient', () => ({
  resolveRegistryBaseUrl: async () => 'https://registry.flujo.com.co',
  signup: (...args: unknown[]) => mockSignup(...args),
}));
import { authenticate } from '@/backend/services/registry';

it('stores remote registry metadata as JSON at the fixed registry-account key', async () => {
  await runWithWorkspace(`registry-boundary-${randomUUID()}`, async () => {
    const remoteEmail = '../../outside.json\n<script>untrusted</script>';
    mockSignup.mockResolvedValue({ status: 201, body: {
      needs_confirmation: true, email: remoteEmail,
      path: '../../outside.json', filePath: '../../outside.json', ignored: 'unselected remote field',
    } });
    await expect(authenticate('fixture@example.invalid', 'synthetic', 'signup', 'fixture')).resolves.toMatchObject({ status: 'confirmation_required' });
    const db = path.join(getWorkspaceDataDir(), 'db');
    const account = JSON.parse(await fs.readFile(path.join(db, `${StorageKey.REGISTRY_ACCOUNT}.json`), 'utf8'));
    expect(account.email).toBe(remoteEmail);
    expect(account.path).toBeUndefined();
    expect(account.filePath).toBeUndefined();
    expect((await fs.readdir(db)).filter(name => name.endsWith('.json'))).toEqual([`${StorageKey.REGISTRY_ACCOUNT}.json`]);
    expect((await fs.readdir(getWorkspaceDataDir())).filter(name => name === 'outside.json')).toEqual([]);
  });
});
