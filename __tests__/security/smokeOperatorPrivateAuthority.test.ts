import { createSmokeOperator } from '../../scripts/smoke-bundled-operator.mjs';
import { authenticateOwnerBearer, ownerHasScopes, ownerPolicySchema } from '@/backend/services/security/ownerCredentials';
import { readPrivateApprovalAsync } from '@/backend/services/security/trustedHostMcp';

test('real smoke operator authority passes the production private reader and authenticates its genuine credential', async () => {
  const operator = await createSmokeOperator();
  let primary: unknown;
  let failed = false;
  try {
    const policy = ownerPolicySchema.parse(await readPrivateApprovalAsync(operator.env.FLUJO_OWNER_AUTH_FILE));
    expect(policy.ownerId).toBe('packed-smoke-operator');
    expect(policy.credentials).toHaveLength(1);
    const principal = authenticateOwnerBearer(new Request('http://localhost:4200', {
      headers: { authorization: `Bearer ${operator.token}` },
    }), policy);
    expect(principal).not.toBeNull();
    if (!principal) throw new Error('Genuine smoke operator credential refused.');
    expect(ownerHasScopes(principal, ['control:admin', 'mcp:access', 'secrets:read'])).toBe(true);
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    try { await operator.restore(); }
    catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], 'Smoke operator fixture cleanup failed.'); }
  }
}, 60_000);
