import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { ticketService } from '@/backend/services/ticket';
import { TicketPatchSchema } from '@/backend/services/ticket/schema';
import { json } from '../_helpers';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const ticket = await ticketService.getTicket((await params).id);
  return ticket ? json(ticket) : json({ error: 'Ticket not found.' }, 404);
}
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const body = await request.json().catch(() => null);
  const parsed = TicketPatchSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Invalid ticket update.' }, 400);
  const result = await ticketService.updateTicket((await params).id, parsed.data);
  return result.success ? json(result.ticket) : json({ error: result.error }, result.error === 'Ticket not found.' ? 404 : 400);
}
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked(); if (lock) return lock;
  const result = await ticketService.deleteTicket((await params).id);
  return result.success ? new Response(null, { status: 204 }) : json({ error: result.error }, 404);
}
