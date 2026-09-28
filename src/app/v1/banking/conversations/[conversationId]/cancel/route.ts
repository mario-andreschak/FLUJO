import { bankingCancel } from '@/backend/services/banking/controllers';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  return bankingCancel(request, (await context.params).conversationId);
}
