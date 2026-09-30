import { validateBankingResult } from '@/integrations/hackathon-banking/protocol';

// Delegated response shapes from banking_mcp/service.py; all values are synthetic fixtures.
const transaction = {
  transaction_reference: 'txn_012345abcdef', transaction_date: '2026-01-02', process_date: '2026-01-02',
  amount: '1.00', currency: 'USD', status: 'posted', merchant: null, transaction_type: 'purchase',
  channel: 'card', product: 'fixture',
};
const status = { service: 'banking-mcp', version: '1.0', read_only: false, sandbox_actions_only: true, mode: 'delegated',
  dataset_ready: true, customer_assertion_required: true, customer_selection_required: false,
  conversation_correlation_required: false, source_verification_configured: false,
  tools: ['banking_status', 'list_my_transactions', 'get_my_transaction',
    'prepare_unrecognized_charge', 'confirm_simulated_intake', 'read_intake_receipt',
    'create_verified_handoff', 'read_verified_handoff'] };
const list = { transactions: [{ ...transaction, selection_handle: 'a'.repeat(32) }], next_cursor: null,
  date_window: { start: '2026-01-01', end: '2026-01-31', basis: 'transaction_date',
    calendar: 'source_timestamp_calendar_date', anchor: '2026-01-31', max_calendar_days: 90 },
  snapshot_event_dates: { first: '2026-01-01', last: '2026-01-31',
    basis: 'transaction_date', calendar: 'source_timestamp_calendar_date' }, snapshot: 'fixture_snapshot',
  freshness: 'derived_snapshot', read_only: true, synthetic: false, operator_test: false };
const get = { transaction, snapshot: 'fixture_snapshot', freshness: 'derived_snapshot',
  read_only: true, synthetic: false, operator_test: false,
  existing_case: { state: 'not_found', receipt: null, coverage: 'sandbox_only', source: 'sandbox_cases' } };
const actionBase = { synthetic: false, operator_test: false };
const receipt = { id: 'CMP-SBX-abcdefgh', kind: 'simulated_intake', simulated: true,
  snapshot: 'fixture_snapshot', created_at: '2026-09-29T00:00:00Z', status: 'received', transaction };
const handoff = { id: 'HOF-abcdefgh', reason: 'missing_evidence', snapshot: 'fixture_snapshot',
  created_at: '2026-09-29T00:00:00Z', facts: transaction, human_responded: false,
  transaction_currentness: 'same_snapshot',
  packet: { schema: 'banking-sandbox-handoff/v1', transaction, reason: 'missing_evidence',
    transaction_provenance: { source: 'owned_serving_snapshot', snapshot: 'fixture_snapshot', as_of: '2026-09-29T00:00:00Z' },
    unanswered_questions: ['¿Reconoce este cargo?'], human_responded: false } };
const prepared = { pending_handle: 'a'.repeat(43), snapshot: 'fixture_snapshot',
  action: 'simulated_intake', decision: 'handoff', reason: 'missing_evidence', transaction,
  existing_case: get.existing_case,
  risk: { unrecognized_count_24h: null, risk_data_complete: false, coverage: 'sandbox_only',
    source: 'sandbox_cases', window_start: '2026-09-28T00:00:00Z',
    window_end: '2026-09-29T00:00:00Z' }, ...actionBase };
function response(data: object, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
    ...(isError === undefined ? {} : { isError }) };
}

describe('delegated Python banking result contract', () => {
  test.each([['banking_status', status], ['list_my_transactions', list], ['get_my_transaction', get],
    ['get_my_transaction', { ...get, freshness: 'verified_against_pinned_source' }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, state: 'verified', receipt } }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, state: 'action_unverified' } }],
    ['prepare_unrecognized_charge', prepared],
    ['prepare_unrecognized_charge', { ...prepared, decision: 'existing_case', reason: null,
      existing_case: { ...get.existing_case, state: 'verified', receipt } }],
    ['prepare_unrecognized_charge', { ...prepared, reason: 'action_unverified',
      existing_case: { ...get.existing_case, state: 'action_unverified' } }],
    ['confirm_simulated_intake', { state: 'created', receipt, ...actionBase }],
    ['read_intake_receipt', { state: 'action_unverified', receipt: null, ...actionBase }],
    ['create_verified_handoff', { state: 'created', handoff, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff, ...actionBase }]])(
    'accepts the complete delegated %s response and preserves its public fields', (tool, data) => {
      const validated = validateBankingResult(tool as string, response(data as object)) as {
        content: { type: string; text: string }[]; structuredContent: unknown;
      };
      expect(validated.structuredContent).toEqual(data);
      expect(validated.content).toHaveLength(1);
      expect(validated.content[0].type).toBe('text');
      expect(JSON.parse(validated.content[0].text)).toEqual(data);
    });

  test.each([
    ['banking_status', { ...status, customer_selection_required: true }],
    ['banking_status', { ...status, conversation_correlation_required: true }],
    ['banking_status', { ...status, customer_assertion_required: false }],
    ['banking_status', { ...status, mode: 'operator-test' }],
    ['banking_status', { ...status, sandbox_actions_only: false }],
    ['list_my_transactions', { ...list, operator_test: true }],
    ['get_my_transaction', { ...get, operator_test: true }],
    ['list_my_transactions', { ...list, synthetic: true }],
    ['get_my_transaction', { ...get, synthetic: true }],
    ['banking_status', { ...status, unknown: false }],
    ['list_my_transactions', { ...list, customer_id: 'foreign' }],
    ['get_my_transaction', { ...get, transaction: { ...transaction, customer_id: 'foreign' } }],
    ['prepare_unrecognized_charge', { ...prepared, risk: { ...prepared.risk, unrecognized_count_24h: 0 } }],
    ['confirm_simulated_intake', { state: 'created', receipt: { ...receipt, simulated: false }, ...actionBase }],
    ['create_verified_handoff', { state: 'created', handoff: { ...handoff, human_responded: true }, ...actionBase }],
  ])('rejects operator or unexpected data for %s', (tool, data) => {
    expect(() => validateBankingResult(tool as string, response(data as object)))
      .toThrow('banking_protocol_result_rejected');
  });

  test('accepts exactly 90 source calendar dates across unequal month lengths', () => {
    const value = { ...list, date_window: { ...list.date_window, start: '2026-01-01',
      end: '2026-03-31', anchor: '2026-03-31' },
      snapshot_event_dates: { ...list.snapshot_event_dates, last: '2026-03-31' } };
    expect(() => validateBankingResult('list_my_transactions', response(value))).not.toThrow();
  });

  test('uses the disclosed source timestamp calendar date without converting it to UTC', () => {
    const value = { ...list, transactions: [{ ...list.transactions[0], transaction_date: '2026-01-02T23:59:00-05:00' }],
      date_window: { ...list.date_window, start: '2026-01-02', end: '2026-01-02', anchor: '2026-01-02' },
      snapshot_event_dates: { ...list.snapshot_event_dates, first: '2026-01-02', last: '2026-01-02' } };
    expect(() => validateBankingResult('list_my_transactions', response(value))).not.toThrow();
  });

  test('an explicit older window is valid anywhere within the disclosed snapshot bounds', () => {
    const value = { ...list, date_window: { ...list.date_window, anchor: '2026-12-31' },
      snapshot_event_dates: { ...list.snapshot_event_dates, last: '2026-12-31' } };
    expect(() => validateBankingResult('list_my_transactions', response(value))).not.toThrow();
  });

  test('a short serving snapshot can bound a default window to fewer than 90 dates', () => {
    const value = { ...list, date_window: { ...list.date_window, start: '2026-01-02' },
      snapshot_event_dates: { ...list.snapshot_event_dates, first: '2026-01-02' } };
    expect(() => validateBankingResult('list_my_transactions', response(value))).not.toThrow();
  });

  test('91 inclusive calendar dates are rejected even when covered by the snapshot', () => {
    const value = { ...list, date_window: { ...list.date_window, end: '2026-04-01', anchor: '2026-04-01' },
      snapshot_event_dates: { ...list.snapshot_event_dates, last: '2026-04-01' } };
    expect(() => validateBankingResult('list_my_transactions', response(value))).toThrow('banking_protocol_result_rejected');
  });

  test('a matching existing receipt retains its original case snapshot', () => {
    const value = { ...get, existing_case: { ...get.existing_case, state: 'verified',
      receipt: { ...receipt, snapshot: 'older-case-snapshot' } } };
    expect(() => validateBankingResult('get_my_transaction', response(value))).not.toThrow();
  });

  test.each([
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, basis: 'process_date' } }],
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, start: '2025-11-02' } }],
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, end: '2026-02-30' } }],
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, start: '2026-02-01' } }],
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, end: '2026-02-01' } }],
    ['list_my_transactions', { ...list, date_window: { ...list.date_window, anchor: '2026-02-01' } }],
    ['list_my_transactions', { ...list, snapshot_event_dates: { ...list.snapshot_event_dates, first: '2026-02-01' } }],
    ['list_my_transactions', { ...list, transactions: [{ ...list.transactions[0], transaction_date: '2025-12-31T23:59:00-05:00' }] }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, state: 'verified' } }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, receipt } }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, state: 'action_unverified', receipt } }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, state: 'verified',
      receipt: { ...receipt, transaction: { ...transaction, amount: '2.00' } } } }],
    ['get_my_transaction', { ...get, existing_case: { ...get.existing_case, customer_id: 'foreign' } }],
    ['prepare_unrecognized_charge', { ...prepared, decision: 'existing_case', reason: null }],
    ['prepare_unrecognized_charge', { ...prepared, existing_case: { ...get.existing_case, state: 'verified', receipt } }],
    ['prepare_unrecognized_charge', { ...prepared, existing_case: { ...get.existing_case, state: 'action_unverified' } }],
    ['confirm_simulated_intake', { state: 'created', receipt: { ...receipt, status: 'resolved' }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff, packet: undefined }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, reason: 'customer_request' } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, transaction: { ...transaction, amount: '2.00' } } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, human_responded: true } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, transaction_provenance: null } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, transaction_provenance: { ...handoff.packet.transaction_provenance,
        snapshot: 'different-build' } } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff, transaction_currentness: 'not_applicable' }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, unanswered_questions: Array(9).fill('Question') } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, unanswered_questions: ['x'.repeat(241)] } }, ...actionBase }],
    ['read_verified_handoff', { state: 'created', handoff: { ...handoff,
      packet: { ...handoff.packet, unanswered_questions: ['\u0000'] } }, ...actionBase }],
  ])('rejects inconsistent event-date, receipt or handoff evidence for %s (case %#)', (tool, data) => {
    expect(() => validateBankingResult(tool as string, response(data as object)))
      .toThrow('banking_protocol_result_rejected');
  });

  test('legacy receipt without persisted received status is rejected', () => {
    const { status: _status, ...legacy } = receipt;
    expect(() => validateBankingResult('read_intake_receipt',
      response({ state: 'created', receipt: legacy, ...actionBase }))).toThrow('banking_protocol_result_rejected');
  });

  test('no-target handoff has no invented transaction facts', () => {
    const noTarget = { ...handoff, facts: {}, snapshot: null, transaction_currentness: 'not_applicable',
      packet: { ...handoff.packet, transaction: null, transaction_provenance: null } };
    expect(() => validateBankingResult('read_verified_handoff', response({ state: 'created', handoff: noTarget,
      ...actionBase }))).not.toThrow();
  });

  test.each(['different_snapshot', 'unknown'])('historical handoff facts remain valid with %s currentness', currentness => {
    expect(() => validateBankingResult('read_verified_handoff', response({ state: 'created',
      handoff: { ...handoff, transaction_currentness: currentness }, ...actionBase }))).not.toThrow();
  });

  test('legacy or unresolved ledger errors retain the safe action_unverified code', () => {
    const value = response({ error: 'action_unverified' }, true);
    expect(validateBankingResult('read_verified_handoff', value)).toEqual(value);
  });

  test.each([['banking_status', status, 'customer_selection_required'],
    ['banking_status', status, 'conversation_correlation_required'],
    ['list_my_transactions', list, 'operator_test'], ['get_my_transaction', get, 'operator_test']])(
    'requires each delegated indicator for %s (case %#)', (tool, data, field) => {
      const missing: Record<string, unknown> = { ...(data as object) };
      delete missing[field as string];
      expect(() => validateBankingResult(tool as string, response(missing)))
        .toThrow('banking_protocol_result_rejected');
    });

  test('accepts a safe bank error without success-only indicators', () => {
    const result = response({ error: 'reference_unavailable' }, true);
    expect(validateBankingResult('get_my_transaction', result)).toEqual(result);
  });

  test.each([
    response({ error: 'unexpected_internal_error' }, true),
    response({ error: 'reference_unavailable', operator_test: false }, true),
    { ...response(list), isError: true },
    { ...response(list), task: { taskId: 'foreign' } },
    { ...response(list), _meta: { ui: { resourceUri: 'ui://foreign' } } },
    { ...response(list), content: [{ type: 'image', data: 'synthetic', mimeType: 'image/png' }] },
    { ...response(list), content: [{ type: 'resource', resource: { uri: 'file://foreign', text: 'foreign' } }] },
    { ...response(list), content: [{ type: 'text', text: JSON.stringify({ ...list, operator_test: true }) }] },
  ])('rejects error, task, media and contradictory response wrappers %#', value => {
    expect(() => validateBankingResult('list_my_transactions', value))
      .toThrow('banking_protocol_result_rejected');
  });
});
