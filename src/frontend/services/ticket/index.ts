import type { CreateTicketInput, Ticket, TicketPage, TicketPatch, TicketQuery } from '@/shared/types/ticket';
async function parse<T>(response: Response): Promise<T> { const body = await response.json().catch(() => undefined); if (!response.ok) throw new Error(body?.error ?? 'Ticket request failed.'); return body as T; }
class TicketService {
  async countTickets(): Promise<number> { return (await parse<{ count: number }>(await fetch('/api/tickets?presence=1'))).count; }
  async listTickets(query: TicketQuery = {}): Promise<TicketPage> { const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value)); return parse<TicketPage>(await fetch('/api/tickets?' + params.toString())); }
  async getTicket(id: string): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets/' + encodeURIComponent(id))); }
  async createTicket(input: CreateTicketInput): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })); }
  async updateTicket(id: string, patch: TicketPatch): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })); }
  async deleteTicket(id: string): Promise<void> { await parse<void>(await fetch('/api/tickets/' + encodeURIComponent(id), { method: 'DELETE' })); }
  async deleteTickets(ids: string[]): Promise<{ deleted: number; errors: number }> { return parse(await fetch('/api/tickets', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })); }
}
export const ticketService = new TicketService();
