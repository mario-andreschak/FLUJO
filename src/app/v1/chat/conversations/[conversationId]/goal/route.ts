import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import {
  clearChatGoal,
  getChatGoal,
  pauseChatGoal,
  readChatGoalTarget,
  resumeChatGoal,
  setChatGoal,
  type ChatGoalChange,
} from '@/backend/services/chatGoals/chatGoalRuntime';
import { CHAT_GOAL_TEXT_LIMIT, type ChatGoalRefusal, type ChatGoalResponse, type ChatGoalUpdate } from '@/shared/types/chatGoal';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

type Params = { params: Promise<{ conversationId: string }> };

const REFUSAL_STATUS: Record<ChatGoalRefusal, number> = {
  persona_owned: 409, read_only: 409, protected: 409, not_found: 404, invalid_text: 400, no_goal: 404,
};

function refuse(reason: ChatGoalRefusal, error: string) {
  return NextResponse.json({ error, reason }, { status: REFUSAL_STATUS[reason] });
}

function answer(change: ChatGoalChange, status = 200) {
  if ('refusal' in change) return refuse(change.refusal, change.message);
  return NextResponse.json({ goal: change.goal, running: change.running } satisfies ChatGoalUpdate, { status });
}

/** Unlock and local-only checks shared by every method, plus a safe chat id. */
async function admit(request: NextRequest, { params }: Params): Promise<{ conversationId: string } | NextResponse> {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const { conversationId } = await params;
  if (!conversationId || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) {
    return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 });
  }
  return { conversationId };
}

/** The chat's goal, or `null`. */
async function GET_handler(request: NextRequest, context: Params) {
  const admitted = await admit(request, context);
  if (admitted instanceof NextResponse) return admitted;
  return NextResponse.json({ goal: await getChatGoal(admitted.conversationId) } satisfies ChatGoalResponse);
}

/**
 * "/goal <text>" in a chat with an agent (#1225): FLUJO keeps the agent working
 * on it, one turn after another, until the agent says it is met. A new goal
 * replaces the old one. Persona chats keep their Persona goals.
 */
async function POST_handler(request: NextRequest, context: Params) {
  const admitted = await admit(request, context);
  if (admitted instanceof NextResponse) return admitted;
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return refuse('invalid_text', 'Send JSON with the goal as "text".');
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) return refuse('invalid_text', 'Say what the goal is.');
  if (text.length > CHAT_GOAL_TEXT_LIMIT) {
    return refuse('invalid_text', `A goal can be at most ${CHAT_GOAL_TEXT_LIMIT} characters long.`);
  }
  return answer(await setChatGoal(admitted.conversationId, text), 201);
}

/** `{ "action": "pause" }` holds the goal; `{ "action": "resume" }` lets it go on. */
async function PATCH_handler(request: NextRequest, context: Params) {
  const admitted = await admit(request, context);
  if (admitted instanceof NextResponse) return admitted;
  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send JSON with "action": "pause" or "resume".' }, { status: 400 });
  }
  if (body?.action === 'resume') {
    const change = await resumeChatGoal(admitted.conversationId);
    if (!('refusal' in change) && !change.goal) return refuse('no_goal', 'This chat has no goal.');
    return answer(change);
  }
  if (body?.action !== 'pause') {
    return NextResponse.json({ error: 'Send JSON with "action": "pause" or "resume".' }, { status: 400 });
  }
  const target = await readChatGoalTarget(admitted.conversationId);
  if ('refusal' in target) return refuse(target.refusal, target.message);
  const goal = await pauseChatGoal(admitted.conversationId, 'person');
  if (!goal) return refuse('no_goal', 'This chat has no goal.');
  return NextResponse.json({ goal } satisfies ChatGoalResponse);
}

/** Remove the goal. Answers with the goal that was removed, or `null`. */
async function DELETE_handler(request: NextRequest, context: Params) {
  const admitted = await admit(request, context);
  if (admitted instanceof NextResponse) return admitted;
  return NextResponse.json({ goal: await clearChatGoal(admitted.conversationId) } satisfies ChatGoalResponse);
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
export const PATCH = withWorkspaceRoute(PATCH_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
