import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  InvalidPersonaSummaryCursorError,
  listPersonaSummaries,
} from '@/backend/services/enduringAgents/personaSummary';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/v1/personas/summary/route');
export const dynamic = 'force-dynamic';

function singleQueryValue(
  request: NextRequest,
  name: string,
): string | null | undefined {
  const values = request.nextUrl.searchParams.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
}

async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request); if (notLocal) return notLocal;
  const locked = await assertUnlocked({ openai: true }); if (locked) return locked;

  const cursor = singleQueryValue(request, 'cursor');
  const rawPageSize = singleQueryValue(request, 'pageSize');
  if (
    cursor === undefined
    || rawPageSize === undefined
    || cursor === ''
    || (rawPageSize !== null && !/^\d+$/.test(rawPageSize))
  ) {
    return NextResponse.json(
      { error: 'Invalid Persona summary pagination.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await listPersonaSummaries({
      ...(cursor === null ? {} : { cursor }),
      ...(rawPageSize === null ? {} : { pageSize: Number(rawPageSize) }),
    }));
  } catch (error) {
    if (error instanceof InvalidPersonaSummaryCursorError || error instanceof RangeError) {
      return NextResponse.json(
        { error: 'Invalid Persona summary pagination.' },
        { status: 400 },
      );
    }
    log.error('Failed to list Persona summaries', error);
    return NextResponse.json(
      { error: 'Failed to list Persona summaries.' },
      { status: 500 },
    );
  }
}

export const GET = withWorkspaceRoute(GET_handler);
