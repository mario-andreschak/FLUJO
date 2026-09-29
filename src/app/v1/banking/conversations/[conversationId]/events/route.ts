import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { bankingEvents } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function GET_handler(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return bankingEvents(request, (await context.params).conversationId);
}
export const GET = withWorkspaceRoute(GET_handler);
