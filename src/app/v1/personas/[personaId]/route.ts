import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { personaDomainErrorResponse } from '@/app/v1/personas/_domainResponse';
import {
  PersonaDeletionConflictError,
  PersonaDeletionNotFoundError,
  deletePersona,
  listPersonaFlowDispatches,
  pumpPersonaFlowDispatches,
  projectPersonaPresentation,
  readPersonaRuntimeSnapshot,
  type MemoryMaintenanceResult,
  updatePersonaSettings,
} from '@/backend/services/enduringAgents';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

const PERSONA_RESULT_SUMMARY_LIMIT = 600;

function boundedResultSummary(value: string | undefined): string | undefined {
  const compact = value?.trim().replace(/\s+/g, ' ');
  if (!compact) return undefined;
  if (compact.length <= PERSONA_RESULT_SUMMARY_LIMIT) return compact;
  return `${compact.slice(0, PERSONA_RESULT_SUMMARY_LIMIT - 3).trimEnd()}...`;
}

function maintenanceResultSummary(result: MemoryMaintenanceResult): string {
  switch (result.status) {
    case 'saved':
      return `Saved ${result.createdCount} of ${result.proposedCount} proposed memory candidate${result.proposedCount === 1 ? '' : 's'}.`;
    case 'no_proposals':
      return 'No durable memory candidates were proposed.';
    case 'invalid_output': {
      const first = result.issues[0];
      const location = first?.path ? ` at ${first.path}` : '';
      const count = result.proposedCount;
      return count > 0
        ? `Rejected ${count} proposed memory candidate${count === 1 ? '' : 's'}: maintenance output failed validation${location}.`
        : `Saved 0 memory candidates: maintenance output failed validation${location}.`;
    }
    case 'rejected':
      return `Saved 0 of ${result.proposedCount} proposed memory candidate${result.proposedCount === 1 ? '' : 's'} because the proposals did not reference supplied evidence.`;
    case 'disabled':
      return 'Memory candidate creation was disabled for this Activity.';
  }
}

async function GET_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  try {
    const [snapshot, dispatches] = await Promise.all([
      readPersonaRuntimeSnapshot(personaId),
      listPersonaFlowDispatches(personaId),
    ]);
    const resultByActivityId = new Map<string, string>();
    for (const dispatch of dispatches) {
      if (dispatch.state === 'completed' && dispatch.admission.kind === 'maintenance') {
        const activityId = dispatch.activityId ?? dispatch.outcome?.activityId;
        if (activityId && dispatch.maintenanceResult) {
          resultByActivityId.set(activityId, maintenanceResultSummary(dispatch.maintenanceResult));
        }
        continue;
      }
      if (
        dispatch.state !== 'completed'
        || dispatch.outcome?.status !== 'completed'
      ) continue;
      const activityId = dispatch.activityId ?? dispatch.outcome?.activityId;
      const result = boundedResultSummary(dispatch.outcome.outputText);
      if (activityId && result) resultByActivityId.set(activityId, result);
    }
    return snapshot
      ? NextResponse.json({
          ...snapshot.bundle,
          runtime: snapshot.runtime,
          presentation: projectPersonaPresentation(snapshot.bundle, {
            activeActivityId: snapshot.runtime.projection.active?.activityId,
            ...(resultByActivityId.size > 0 ? { resultByActivityId } : {}),
          }),
        })
      : NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  } catch (error) {
    log.error(`Failed to read Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to read Persona.' }, { status: 500 });
  }
}

async function PATCH_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    const persona = await updatePersonaSettings(personaId, body);
    if (persona.lifecycleState === 'idle') {
      void pumpPersonaFlowDispatches(persona.id).catch((error) => {
        log.error(`Failed to resume queued work for Persona ${JSON.stringify(persona.id)}`, error);
      });
    }
    return NextResponse.json(persona);
  } catch (error) {
    const response = personaDomainErrorResponse(error); if (response) return response;
    log.error(`Failed to update Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to update Persona.' }, { status: 500 });
  }
}

async function DELETE_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  const body = await request.json().catch(() => null);
  try {
    return NextResponse.json(await deletePersona(personaId, body));
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid Persona deletion confirmation.' }, { status: 400 });
    }
    if (error instanceof PersonaDeletionNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof PersonaDeletionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    log.error(`Failed to delete Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json({ error: 'Failed to delete Persona.' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
