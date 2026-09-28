import { bankingConversation } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ conversationId: string }> };
export async function GET(request: Request, context: Context) {
  return bankingConversation(request, (await context.params).conversationId);
}
export async function DELETE(request: Request, context: Context) {
  return bankingConversation(request, (await context.params).conversationId, true);
}
