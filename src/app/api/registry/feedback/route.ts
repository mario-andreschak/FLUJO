/**
 * POST /api/registry/feedback
 *
 * Validates anonymous start-page feedback and forwards it as a JSON payload to
 * the hosted registry. Neither this route nor the registry interpolates the
 * message into SQL; the registry inserts it through Supabase's query builder.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { submitFeedback } from '@/backend/utils/packageRegistryClient';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { assertUnlocked } from '@/utils/encryption/lockGate';

const log = createLogger('app/api/registry/feedback/route');

const feedbackSchema = z
  .object({
    notice: z.string().transform((value) => value.trim()),
    rating: z.union([z.literal(1), z.literal(5)]),
  })
  .strict()
  .refine(
    ({ notice }) => {
      const length = Array.from(notice).length;
      // Issue #377: an empty message is allowed; only the upper bound is enforced.
      return length <= 255;
    },
    { path: ['notice'], message: 'Feedback must not exceed 255 characters' },
  );

export async function POST(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  // #77 deny-by-default encryption gate.
  const locked = await assertUnlocked();
  if (locked) return locked;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = feedbackSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'A happy/unhappy selection is required and feedback must not exceed 255 characters.' },
      { status: 400 },
    );
  }

  try {
    const result = await submitFeedback(parsed.data.notice, parsed.data.rating);
    if (result.status === 201 && result.body.accepted) {
      return NextResponse.json({ accepted: true }, { status: 201 });
    }
    if (result.status === 400 || result.status === 429) {
      return NextResponse.json(
        { error: result.status === 429 ? 'Too many feedback submissions. Please try again later.' : 'Invalid feedback.' },
        { status: result.status },
      );
    }
    return NextResponse.json(
      { error: 'The feedback service is temporarily unavailable.' },
      { status: 502 },
    );
  } catch (error) {
    log.error('Feedback submission failed', error);
    return NextResponse.json(
      { error: 'The feedback service is temporarily unavailable.' },
      { status: 500 },
    );
  }
}
