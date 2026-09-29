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
const actionTools = z.enum(['banking_status', 'list_my_transactions', 'get_my_transaction',
  'prepare_unrecognized_charge', 'confirm_simulated_intake', 'read_intake_receipt',
  'create_verified_handoff', 'read_verified_handoff']);
const actionBase = { synthetic: z.literal(false), operator_test: z.literal(false) };
const receipt = z.object({ id: z.string().regex(/^CMP-SBX-[A-Za-z0-9_-]{8}$/), kind: z.literal('simulated_intake'),
  simulated: z.literal(true), snapshot, created_at: z.string().datetime(), transaction }).strict();
const handoff = z.object({ id: z.string().regex(/^HOF-[A-Za-z0-9_-]{8}$/),
  reason: z.enum(['high_risk', 'missing_evidence', 'out_of_policy', 'emergency',
    'action_unverified', 'customer_request', 'clarification_exhausted',
    'duplicate_review', 'no_match_exhausted', 'tool_failure']), snapshot: snapshot.nullable(),
  created_at: z.string().datetime(), facts: z.union([transaction, z.object({}).strict()]),
  human_responded: z.literal(false) }).strict();
const resultSchemas = {
  banking_status: z.object({ service: z.literal('banking-mcp'), version: z.string().max(16),
    read_only: z.literal(false), sandbox_actions_only: z.literal(true),
    mode: z.literal('delegated'), dataset_ready: z.boolean(),
    customer_assertion_required: z.literal(true), customer_selection_required: z.literal(false),
    conversation_correlation_required: z.literal(false), source_verification_configured: z.boolean(),
    tools: z.array(actionTools).max(8) }).strict(),
  list_my_transactions: z.object({ transactions: z.array(transaction.extend({ selection_handle: handle })).max(20),
    next_cursor: handle.nullable(), date_window: z.object({ start: z.string().max(10), end: z.string().max(10),
      basis: z.literal('process_date') }).strict(), snapshot, freshness: z.literal('derived_snapshot'),
    read_only: z.literal(true), synthetic: z.literal(false), operator_test: z.literal(false) }).strict(),
  get_my_transaction: z.object({ transaction, snapshot,
    freshness: z.enum(['derived_snapshot', 'verified_against_pinned_source']),
    read_only: z.literal(true), synthetic: z.literal(false), operator_test: z.literal(false) }).strict(),
  prepare_unrecognized_charge: z.object({ pending_handle: handle, snapshot,
    action: z.literal('simulated_intake'), decision: z.enum(['intake', 'handoff']),
    reason: z.enum(['missing_evidence', 'high_risk', 'out_of_policy', 'duplicate_review']).nullable(), transaction,
    risk: z.object({ unrecognized_count_24h: z.number().int().nullable(), risk_data_complete: z.boolean(),
      coverage: z.literal('sandbox_only'), source: z.literal('sandbox_cases'),
      window_start: z.string().datetime(), window_end: z.string().datetime() }).strict()
      .refine(value => value.risk_data_complete || value.unrecognized_count_24h === null),
    ...actionBase }).strict(),
  confirm_simulated_intake: z.object({ state: z.enum(['created', 'action_unverified']),
    receipt: receipt.nullable(), ...actionBase }).strict()
    .refine(value => (value.state === 'created') === (value.receipt !== null)),
  read_intake_receipt: z.object({ state: z.enum(['created', 'action_unverified']),
    receipt: receipt.nullable(), ...actionBase }).strict()
    .refine(value => (value.state === 'created') === (value.receipt !== null)),
  create_verified_handoff: z.object({ state: z.literal('created'), handoff, ...actionBase }).strict(),
  read_verified_handoff: z.object({ state: z.literal('created'), handoff, ...actionBase }).strict(),
};
const errorSchema = z.object({ error: z.enum(['authorization_required', 'authorization_denied',
  'invalid_arguments', 'dataset_unavailable', 'invalid_date_window', 'reference_unavailable',
  'data_quality_error', 'source_verification_unavailable', 'snapshot_changed', 'server_busy', 'service_unavailable',
  'confirmation_required', 'handoff_required', 'risk_data_unavailable']) }).strict();

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
