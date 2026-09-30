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
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const eventBasis = { basis: z.literal('transaction_date'), calendar: z.literal('source_timestamp_calendar_date') };
const handoffReason = z.enum(['high_risk', 'missing_evidence', 'out_of_policy', 'emergency',
  'action_unverified', 'customer_request', 'clarification_exhausted',
  'duplicate_review', 'no_match_exhausted', 'tool_failure']);
export const bankingUnansweredQuestions = z.array(z.string().trim().min(1)
  .refine(value => Array.from(value).length <= 240)
  .regex(/^[^\u0000-\u001f\ud800-\udfff]*$/u)).max(8);
const actionTools = z.enum(['banking_status', 'list_my_transactions', 'get_my_transaction',
  'prepare_unrecognized_charge', 'confirm_simulated_intake', 'read_intake_receipt',
  'create_verified_handoff', 'read_verified_handoff']);
const actionBase = { synthetic: z.literal(false), operator_test: z.literal(false) };
export const bankingReceiptSchema = z.object({ id: z.string().regex(/^CMP-SBX-[A-Za-z0-9_-]{8}$/), kind: z.literal('simulated_intake'),
  simulated: z.literal(true), snapshot, created_at: z.string().datetime(), status: z.literal('received'), transaction }).strict();
const existingCase = z.object({ state: z.enum(['verified', 'not_found', 'action_unverified']),
  receipt: bankingReceiptSchema.nullable(), coverage: z.literal('sandbox_only'), source: z.literal('sandbox_cases') })
  .strict().refine(value => (value.state === 'verified') === (value.receipt !== null));
export const bankingHandoffSchema = z.object({ id: z.string().regex(/^HOF-[A-Za-z0-9_-]{8}$/),
  reason: handoffReason, snapshot: snapshot.nullable(),
  created_at: z.string().datetime(), facts: z.union([transaction, z.object({}).strict()]),
  transaction_currentness: z.enum(['same_snapshot', 'different_snapshot', 'unknown', 'not_applicable']),
  human_responded: z.literal(false), packet: z.object({ schema: z.literal('banking-sandbox-handoff/v1'),
    transaction: transaction.nullable(), reason: handoffReason, unanswered_questions: bankingUnansweredQuestions,
    transaction_provenance: z.object({ source: z.literal('owned_serving_snapshot'), snapshot,
      as_of: z.string().datetime() }).strict().nullable(),
    human_responded: z.literal(false) }).strict() }).strict().refine(value =>
  value.reason === value.packet.reason && (value.packet.transaction === null
    ? value.snapshot === null && value.packet.transaction_provenance === null
      && value.transaction_currentness === 'not_applicable' && Object.keys(value.facts).length === 0
    : value.snapshot !== null && value.packet.transaction_provenance?.snapshot === value.snapshot
      && value.transaction_currentness !== 'not_applicable'
      && canonicalize(value.facts) === canonicalize(value.packet.transaction)));
const resultSchemas = {
  banking_status: z.object({ service: z.literal('banking-mcp'), version: z.string().max(16),
    read_only: z.literal(false), sandbox_actions_only: z.literal(true),
    mode: z.literal('delegated'), dataset_ready: z.boolean(),
    customer_assertion_required: z.literal(true), customer_selection_required: z.literal(false),
    conversation_correlation_required: z.literal(false), source_verification_configured: z.boolean(),
    tools: z.array(actionTools).max(8) }).strict(),
  list_my_transactions: z.object({ transactions: z.array(transaction.extend({ selection_handle: handle })).max(20),
    next_cursor: handle.nullable(), date_window: z.object({ start: calendarDate, end: calendarDate,
      ...eventBasis, anchor: calendarDate, max_calendar_days: z.literal(90) }).strict(),
    snapshot_event_dates: z.object({ first: calendarDate, last: calendarDate, ...eventBasis }).strict(),
    snapshot, freshness: z.literal('derived_snapshot'),
    read_only: z.literal(true), synthetic: z.literal(false), operator_test: z.literal(false) }).strict().refine(value => {
      const { start, end, anchor } = value.date_window;
      return start <= end && end <= anchor && value.snapshot_event_dates.first <= value.snapshot_event_dates.last
        && anchor === value.snapshot_event_dates.last && start >= value.snapshot_event_dates.first
        && Date.parse(end) - Date.parse(start) < 90 * 86400000
        && value.transactions.every(item => calendarDate.safeParse(item.transaction_date.slice(0, 10)).success
          && item.transaction_date.slice(0, 10) >= start && item.transaction_date.slice(0, 10) <= end);
    }),
  get_my_transaction: z.object({ transaction, snapshot,
    freshness: z.enum(['derived_snapshot', 'verified_against_pinned_source']),
    existing_case: existingCase,
    read_only: z.literal(true), synthetic: z.literal(false), operator_test: z.literal(false) }).strict()
    .refine(value => value.existing_case.receipt === null
      || canonicalize(value.existing_case.receipt.transaction) === canonicalize(value.transaction)),
  prepare_unrecognized_charge: z.object({ pending_handle: handle, snapshot,
    action: z.literal('simulated_intake'), decision: z.enum(['intake', 'handoff', 'existing_case']),
    reason: z.enum(['missing_evidence', 'high_risk', 'out_of_policy', 'duplicate_review', 'action_unverified']).nullable(),
    transaction, existing_case: existingCase,
    risk: z.object({ unrecognized_count_24h: z.number().int().nullable(), risk_data_complete: z.boolean(),
      coverage: z.literal('sandbox_only'), source: z.literal('sandbox_cases'),
      window_start: z.string().datetime(), window_end: z.string().datetime() }).strict()
      .refine(value => value.risk_data_complete || value.unrecognized_count_24h === null),
    ...actionBase }).strict().refine(value =>
      (value.decision === 'existing_case') === (value.existing_case.state === 'verified')
      && (value.decision === 'handoff') === (value.reason !== null)
      && (value.existing_case.state !== 'action_unverified'
        || value.decision === 'handoff' && value.reason === 'action_unverified')
      && (value.existing_case.receipt === null
        || canonicalize(value.existing_case.receipt.transaction) === canonicalize(value.transaction))),
  confirm_simulated_intake: z.object({ state: z.enum(['created', 'action_unverified']),
    receipt: bankingReceiptSchema.nullable(), ...actionBase }).strict()
    .refine(value => (value.state === 'created') === (value.receipt !== null)),
  read_intake_receipt: z.object({ state: z.enum(['created', 'action_unverified']),
    receipt: bankingReceiptSchema.nullable(), ...actionBase }).strict()
    .refine(value => (value.state === 'created') === (value.receipt !== null)),
  create_verified_handoff: z.object({ state: z.literal('created'), handoff: bankingHandoffSchema, ...actionBase }).strict(),
  read_verified_handoff: z.object({ state: z.literal('created'), handoff: bankingHandoffSchema, ...actionBase }).strict(),
};
const errorSchema = z.object({ error: z.enum(['authorization_required', 'authorization_denied',
  'invalid_arguments', 'dataset_unavailable', 'invalid_date_window', 'reference_unavailable',
  'data_quality_error', 'source_verification_unavailable', 'snapshot_changed', 'server_busy', 'service_unavailable',
  'confirmation_required', 'handoff_required', 'risk_data_unavailable', 'action_unverified']) }).strict();

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
