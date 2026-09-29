import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { bankingConversation } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ conversationId: string }> };
async function GET_handler(request: Request, context: Context) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return bankingConversation(request, (await context.params).conversationId);
}
async function DELETE_handler(request: Request, context: Context) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return bankingConversation(request, (await context.params).conversationId, true);
}
export const GET = withWorkspaceRoute(GET_handler);
export const DELETE = withWorkspaceRoute(DELETE_handler);
