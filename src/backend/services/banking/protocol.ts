import canonicalize from 'canonicalize';
import { z } from 'zod';
import { BankingError } from './errors';

const handle = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);
const transaction = z.object({
  transaction_reference: z.string().regex(/^txn_[a-f0-9]{12}$/),
  transaction_date: z.string().max(40), process_date: z.string().max(10),
  amount: z.string().max(40), currency: z.string().max(8), status: z.string().max(80),
  merchant: z.string().max(160).nullable(), transaction_type: z.string().max(80),
  channel: z.string().max(80), product: z.string().max(80),
}).strict();
const snapshot = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const resultSchemas = {
  banking_status: z.object({ service: z.literal('banking-mcp'), version: z.string().max(16),
    read_only: z.literal(true), mode: z.literal('delegated'), dataset_ready: z.boolean(),
    customer_assertion_required: z.literal(true), source_verification_configured: z.boolean(),
    tools: z.array(z.enum(['banking_status', 'list_my_transactions', 'get_my_transaction'])).max(3) }).strict(),
  list_my_transactions: z.object({ transactions: z.array(transaction.extend({ selection_handle: handle })).max(20),
    next_cursor: handle.nullable(), date_window: z.object({ start: z.string().max(10), end: z.string().max(10),
      basis: z.literal('process_date') }).strict(), snapshot, freshness: z.literal('derived_snapshot'),
    read_only: z.literal(true), synthetic: z.literal(false) }).strict(),
  get_my_transaction: z.object({ transaction, snapshot,
    freshness: z.enum(['derived_snapshot', 'verified_against_pinned_source']),
    read_only: z.literal(true), synthetic: z.literal(false) }).strict(),
};
const errorSchema = z.object({ error: z.enum(['authorization_required', 'authorization_denied',
  'invalid_arguments', 'dataset_unavailable', 'invalid_date_window', 'reference_unavailable',
  'data_quality_error', 'source_verification_unavailable', 'snapshot_changed', 'server_busy', 'service_unavailable']) }).strict();

/** Reject tasks/input requests, Apps metadata, media/resources and contradictory text. */
export function validateBankingResult(tool: string, value: unknown): unknown {
  try {
    const wrapper = z.object({ content: z.tuple([z.object({ type: z.literal('text'), text: z.string().max(65536) }).strict()]),
      structuredContent: z.record(z.string(), z.unknown()), isError: z.boolean().optional() }).strict().parse(value);
    const schema = wrapper.isError ? errorSchema : resultSchemas[tool as keyof typeof resultSchemas];
    if (!schema) throw new Error();
    const data = schema.parse(wrapper.structuredContent);
    if (canonicalize(JSON.parse(wrapper.content[0].text)) !== canonicalize(data)) throw new Error();
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
      ...(wrapper.isError ? { isError: true } : {}) };
  } catch {
    throw new BankingError('banking_protocol_result_rejected', 502);
  }
}
