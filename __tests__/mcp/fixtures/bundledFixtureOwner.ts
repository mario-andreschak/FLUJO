import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueOwnerCredential, ownerPolicySchema } from '@/backend/services/security/ownerCredentials';

/** Provision an owned operator; approval still goes through the real protected writer. */
export function installBundledFixtureOwner() {
  const parent = path.resolve(process.platform === 'win32' ? process.env.LOCALAPPDATA ?? os.tmpdir() : os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'flujo-bundled-owner-'));
  const names = ['FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (path.dirname(path.resolve(directory)) !== parent
        || !/^flujo-bundled-owner-[A-Za-z0-9]+$/.test(path.basename(directory))
        || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe bundled owner fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const expiresAt = Date.now() + 120_000;
    const issued = issueOwnerCredential(['control:admin', 'mcp:access', 'secrets:read'], expiresAt);
    const ownerId = 'owned-bundled-fixture-operator';
    const owner = ownerPolicySchema.parse({ schemaVersion: 1, ownerId, credentials: [issued.record] });
    const ownerFile = path.join(directory, 'owner.json');
    const approvalFile = path.join(directory, 'approval.json');
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
    fs.writeFileSync(approvalFile, JSON.stringify({ schemaVersion: 1, ownerId, approvals: [] }), { mode: 0o600 });
    process.env.FLUJO_OWNER_AUTH_FILE = ownerFile;
    process.env.FLUJO_MCP_TRUSTED_HOST_FILE = approvalFile;
    delete process.env.FLUJO_MCP_ISOLATION_FILE;
    return {
      expiresAt,
      request(serverName: string) {
        return new Request(`http://localhost:4200/api/mcp/servers/${encodeURIComponent(serverName)}/host-consent`, {
          method: 'POST', headers: { host: 'localhost:4200', authorization: `Bearer ${issued.token}` },
        });
      },
      restore,
    };
  } catch (error) {
    try { restore(); } catch { /* Keep the setup error; the owned path remains inspectable. */ }
    throw error;
  }
}
