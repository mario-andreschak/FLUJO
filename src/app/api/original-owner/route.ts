import { z } from 'zod';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { createOriginalOwnerAccount, enrollOriginalOwnerTask,
  listOriginalOwnerRecords, revokeOriginalOwnerRecord } from '@/backend/services/originalOwner/administration';
import { OriginalOwnerError } from '@/backend/services/originalOwner/types';

export const runtime = 'nodejs';
const response = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
async function admitted(request: Request, task: () => Promise<unknown>): Promise<Response> {
  const auth = resolveOwnerRequest(request, ['control:admin', 'secrets:read'], { requireBearer: true });
  if (!auth.ok) return auth.response;
  try {
    const denied = auth.authorization.recheck();
    if (denied) return denied;
    return response(await task());
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return response({ error: 'Check the account or task settings and retry.', code: 'original_owner_invalid_input' }, 400);
    }
    if (error instanceof OriginalOwnerError) return response({ error: error.code, code: error.code }, error.status);
    return response({ error: 'The owner account is unavailable. Retry after the current operation finishes.',
      code: 'original_owner_unavailable' }, 503);
  }
}
export const GET = withWorkspaceRoute((request: Request) => admitted(request, () => listOriginalOwnerRecords(request)));
export const POST = withWorkspaceRoute((request: Request) => admitted(request, async () => {
  const input = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('account'), settings: z.unknown() }).strict(),
    z.object({ operation: z.literal('enroll'), settings: z.unknown() }).strict(),
    z.object({ operation: z.literal('revoke'), id: z.string() }).strict(),
  ]).parse(await request.json());
  if (input.operation === 'account') return createOriginalOwnerAccount(request, input.settings);
  if (input.operation === 'enroll') return enrollOriginalOwnerTask(request, input.settings);
  return revokeOriginalOwnerRecord(request, input.id);
}));
