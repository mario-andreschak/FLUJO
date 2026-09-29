import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { bankingChat } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function POST_handler(request: Request) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  return bankingChat(request);
}
export const POST = withWorkspaceRoute(POST_handler);
