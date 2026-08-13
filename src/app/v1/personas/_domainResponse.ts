import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import {
  PersonaDomainBusyError,
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
} from '@/backend/services/enduringAgents';

export function personaDomainErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ZodError || error instanceof TypeError) {
    return NextResponse.json({ error: 'Invalid Persona domain request.' }, { status: 400 });
  }
  if (error instanceof PersonaDomainNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof PersonaDomainBusyError || error instanceof PersonaDomainConflictError) {
    return NextResponse.json({
      error: error.message,
      code: error.code,
      ...(error instanceof PersonaDomainConflictError && error.details
        ? { details: error.details }
        : {}),
    }, { status: 409 });
  }
  return null;
}
