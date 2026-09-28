import { bankingEvents } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return bankingEvents(request, (await context.params).conversationId);
}
