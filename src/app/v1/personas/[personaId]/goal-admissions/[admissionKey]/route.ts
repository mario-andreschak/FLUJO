import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import { admitPausedPersonaGoal, PausedGoalAdmissionInputSchema, readPersonaGoalAdmission } from '@/backend/services/enduringAgents/goalAdmission';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type RouteContext = { params: Promise<{ personaId: string; admissionKey: string }> };

async function handle(request: NextRequest, context: RouteContext, write: boolean) {
  const notLocal = assertLocalRequest(request, { strictLoopback: true }); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId, admissionKey } = await context.params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success || !/^[a-f0-9]{64}$/.test(admissionKey)) {
    return NextResponse.json({ error: 'Admission not found.' }, { status: 404, headers });
  }
  try {
    // Stream-bound decoded bytes; a forged Content-Length cannot bypass this.
    let input;
    if (write) {
      const reader = request.body?.getReader();
      if (!reader) return NextResponse.json({ error: 'Admission intent required.' }, { status: 400, headers });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 131_072) {
            await reader.cancel();
            return NextResponse.json({ error: 'Admission intent too large.' }, { status: 413, headers });
          }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      input = PausedGoalAdmissionInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    const receipt = write && input
      ? await admitPausedPersonaGoal(personaId, admissionKey, input)
      : await readPersonaGoalAdmission(personaId, admissionKey);
    return receipt ? NextResponse.json(receipt, { headers })
      : NextResponse.json({ error: 'Admission not found.' }, { status: 404, headers });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ error: 'Invalid admission intent.' }, { status: 400, headers });
    }
    const response = personaDomainErrorResponse(error);
    if (response) { response.headers.set('Cache-Control', 'private, no-store'); return response; }
    return NextResponse.json({ error: 'Admission unavailable; reconcile the original key.' }, { status: 503, headers });
  }
}

export const GET = withWorkspaceRoute((request: NextRequest, context: RouteContext) => handle(request, context, false));
export const PUT = withWorkspaceRoute((request: NextRequest, context: RouteContext) => handle(request, context, true));
