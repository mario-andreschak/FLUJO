// Moves an owner approval made before #1337 from a server's saved settings to the form it launches with, once.
import type { MCPStdioConfig } from '@/shared/types/mcp';
import { getCurrentWorkspace } from '@/utils/workspace';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { loadServerConfigs } from '../mcp/config';
import { stdioLaunchForm } from '../mcp/launchForm';
import { ownerPolicySchema } from './ownerCredentials';
import { withPrivateApprovalLedgerLock } from './privateApprovalLedgerLock';
import { createOwnedPrivateApprovalStage } from './ownedPrivateApprovalStage';
import { readPrivateApprovalAsync, readPrivateApprovalPairAsync, sameTrustedHostConsent, trustedHostApprovalsSchema,
  trustedHostEnvironment, trustedHostMcpPolicyDigestAsync } from './trustedHostMcp';

const ENCRYPTED = 'encrypted:';
const GLOBAL_BINDING = '${global:';

/**
 * Before #1337 the owner's review digest covered a server's saved settings,
 * where every secret is still encrypted. FLUJO now approves and checks the
 * launch form (`launchForm.ts`), so such an approval stopped matching and the
 * server asked for a new one. It still names exactly what the owner approved:
 * the same encrypted text always decrypts to the same value. This moves it to
 * the launch form, keeping its owner and expiry, so updating FLUJO needs no
 * second approval.
 *
 * Nothing moves when the saved settings changed since (a new or re-encrypted
 * secret), when a value is or decrypts to a `${global:…}` binding (its value
 * may have changed since the owner approved it), or when the saved settings
 * are not what is launching. Those keep needing a renewed approval. Returns
 * whether the private approval file now holds the launch-form digest.
 */
export async function upgradeStoredFormApproval(launch: MCPStdioConfig, signal?: AbortSignal): Promise<boolean> {
  const filename = process.env.FLUJO_MCP_TRUSTED_HOST_FILE;
  const ownerFile = process.env.FLUJO_OWNER_AUTH_FILE;
  if (!filename || !ownerFile) return false;
  const workspace = getCurrentWorkspace();
  const stored = await storedConfig(launch.name);
  if (!stored || !await secretsDecryptWithoutBindings(stored)
      || !sameTrustedHostConsent(await stdioLaunchForm(stored), launch)) return false;
  const [storedDigest, launchDigest] = await Promise.all([
    trustedHostMcpPolicyDigestAsync(stored, signal), trustedHostMcpPolicyDigestAsync(launch, signal)]);
  if (storedDigest === launchDigest) return false;
  const writer = signal ?? AbortSignal.timeout(30_000);
  return withPrivateApprovalLedgerLock(filename, writer, async () => {
    const [ownerValue, approvalValue] = await readPrivateApprovalPairAsync(ownerFile, filename, writer);
    const owner = ownerPolicySchema.parse(ownerValue);
    const previous = trustedHostApprovalsSchema.parse(approvalValue);
    const grant = previous.approvals.find(item => item.workspace === workspace && item.serverName === launch.name);
    if (previous.ownerId !== owner.ownerId || !grant || grant.expiresAt <= Date.now() || grant.policyDigest !== storedDigest) return false;
    const next = trustedHostApprovalsSchema.parse({ ...previous,
      approvals: previous.approvals.map(item => item === grant ? { ...item, policyDigest: launchDigest } : item) });
    const stage = await createOwnedPrivateApprovalStage(filename, next, writer);
    try {
      await stage.publish(filename, async () => {
        const latest = trustedHostApprovalsSchema.parse(await readPrivateApprovalAsync(filename, writer));
        if (JSON.stringify(latest) !== JSON.stringify(previous)
            || JSON.stringify(await storedConfig(launch.name)) !== JSON.stringify(stored)
            || workspace !== getCurrentWorkspace() || filename !== process.env.FLUJO_MCP_TRUSTED_HOST_FILE) {
          throw new Error('The approval or the saved server settings changed during the upgrade.');
        }
      });
      return true;
    } finally { await stage.dispose(); }
  });
}

async function storedConfig(name: string): Promise<MCPStdioConfig | undefined> {
  const configs = await loadServerConfigs();
  const stored = Array.isArray(configs) ? configs.find(item => item.name === name) : undefined;
  return stored?.transport === 'stdio' && !stored.disabled ? stored : undefined;
}

/** Only encrypted secrets make the saved and launch forms differ; a binding's value is not fixed by the saved text. */
async function secretsDecryptWithoutBindings(stored: MCPStdioConfig): Promise<boolean> {
  const values = [...trustedHostEnvironment(stored).values()];
  const secrets = values.filter(value => value.startsWith(ENCRYPTED));
  if (secrets.length === 0 || values.some(value => value.includes(GLOBAL_BINDING))) return false;
  for (const secret of secrets) {
    const plain = await decryptWithPassword(secret.slice(ENCRYPTED.length));
    if (!plain || plain.includes(GLOBAL_BINDING) || plain.startsWith(ENCRYPTED)) return false;
  }
  return true;
}
