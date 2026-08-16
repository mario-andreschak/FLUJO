import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import {
  RoleAdminConflictError,
  RoleAdminNotFoundError,
} from '@/backend/services/enduringAgents';

export function roleAdminErrorResponse(
  error: unknown,
  invalidMessage = 'Invalid Role configuration.',
): NextResponse | null {
  if (error instanceof ZodError) {
    return NextResponse.json({ error: invalidMessage }, { status: 400 });
  }
  if (error instanceof RoleAdminNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof RoleAdminConflictError) {
    return NextResponse.json({
      error: error.message,
      code: error.code,
      details: error.details,
    }, { status: 409 });
  }
  return null;
}
