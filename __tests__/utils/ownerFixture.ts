import { promises as fs } from 'node:fs';
import path from 'node:path';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';

/** Explicit authenticated operator for tests of behavior after owner admission. */
export async function installOwnerFixture(privateDirectory: string) {
  const previous = process.env.FLUJO_OWNER_AUTH_FILE;
  const now = Date.now();
  const issued = issueOwnerCredential(['control:admin', 'secrets:read', 'mcp:access'], now + 24 * 60 * 60 * 1000, now);
  const filename = path.join(privateDirectory, 'test-owner-policy.json');
  await fs.writeFile(filename, JSON.stringify({ schemaVersion: 1, ownerId: 'fixture-owner', credentials: [issued.record] }), { mode: 0o600 });
  process.env.FLUJO_OWNER_AUTH_FILE = filename;
  return {
    headers: { authorization: `Bearer ${issued.token}` },
    restore() {
      if (previous === undefined) delete process.env.FLUJO_OWNER_AUTH_FILE;
      else process.env.FLUJO_OWNER_AUTH_FILE = previous;
    },
  };
}
