import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import {
  BehaviorLearningPolicyError,
  BehaviorProposalConflictError,
  BehaviorProposalNotFoundError,
} from '@/backend/services/enduringAgents';

export function personaImprovementErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ZodError || error instanceof TypeError) {
    return NextResponse.json({ error: 'That improvement request is not valid.' }, { status: 400 });
  }
  if (error instanceof BehaviorProposalNotFoundError) {
    return NextResponse.json({ error: 'Improvement not found.' }, { status: 404 });
  }
  if (
    error instanceof BehaviorLearningPolicyError
    || error instanceof BehaviorProposalConflictError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  return null;
}
