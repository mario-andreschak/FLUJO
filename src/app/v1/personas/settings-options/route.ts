import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { getPersonaSettingsOptions } from '@/backend/services/enduringAgents/personaSettingsOptions';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/settings-options/route');
export const dynamic = 'force-dynamic';

async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;

  try {
    return NextResponse.json(await getPersonaSettingsOptions());
  } catch (error) {
    log.error('Failed to load Persona settings options', error);
    return NextResponse.json(
      { error: 'Failed to load Persona settings options.' },
      { status: 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
