import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  exportPersonaConfiguration,
  PersonaConfigurationExportNotFoundError,
} from '@/backend/services/enduringAgents/personaConfigurationExport';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/[personaId]/export/route');
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ personaId: string }> };

async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;
  const { personaId } = await params;
  if (!EnduringAgentIdSchema.safeParse(personaId).success) {
    return NextResponse.json({ error: 'Persona not found.' }, { status: 404 });
  }
  let body: unknown = {};
  try {
    const rawBody = await request.text();
    if (rawBody.trim()) body = JSON.parse(rawBody) as unknown;
  } catch {
    return NextResponse.json(
      { error: 'Invalid Persona export selection.' },
      { status: 400 },
    );
  }

  try {
    const artifact = await exportPersonaConfiguration(personaId, body);
    return new NextResponse(artifact.json, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${artifact.preview.artifact.filename}"`,
        'X-Content-SHA256': artifact.preview.artifact.sha256,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Invalid Persona export selection.' },
        { status: 400 },
      );
    }
    if (error instanceof PersonaConfigurationExportNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error(`Failed to export Persona ${JSON.stringify(personaId)}`, error);
    return NextResponse.json(
      { error: 'Failed to export Persona.' },
      { status: 500 },
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
