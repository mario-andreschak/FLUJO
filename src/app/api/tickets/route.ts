import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { ticketService } from '@/backend/services/ticket';
import { CreateTicketInputSchema } from '@/backend/services/ticket/schema';
import { json } from './_helpers';

export async function GET(request: NextRequest) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const { searchParams } = request.nextUrl;
  if (searchParams.get('presence') === '1') {
    const page = await ticketService.listTickets({ status: searchParams.get('status') === 'done' ? 'done' : 'open', limit: 1 });
    return json({ count: page.total });
  }
  const status = searchParams.get('status');
  const limit = Number(searchParams.get('limit') ?? 20);
  const offset = Number(searchParams.get('offset') ?? 0);
  return json(await ticketService.listTickets({
    ...(status === 'open' || status === 'done' ? { status } : {}),
    ...(searchParams.get('label') ? { label: searchParams.get('label')! } : {}),
    ...(searchParams.get('search') ? { search: searchParams.get('search')! } : {}),
    limit: Number.isFinite(limit) ? limit : 20, offset: Number.isFinite(offset) ? offset : 0,
  }));
}

export async function POST(request: NextRequest) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const body = await request.json().catch(() => null);
  const parsed = CreateTicketInputSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Invalid ticket input.' }, 400);
  const result = await ticketService.createTicket(parsed.data);
  return result.success ? json(result.ticket, 201) : json({ error: result.error }, 400);
}

export async function DELETE(request: NextRequest) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.ids) || body.ids.length > 500 || !body.ids.every((id: unknown) => typeof id === 'string')) {
    return json({ error: 'Expected up to 500 ticket ids.' }, 400);
  }
  return json(await ticketService.deleteTickets(body.ids));
}
