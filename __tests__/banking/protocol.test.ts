import { validateBankingResult } from '@/integrations/hackathon-banking/protocol';

// Delegated response shapes from banking_mcp/service.py; all values are synthetic fixtures.
const transaction = {
  transaction_reference: 'txn_012345abcdef', transaction_date: '2026-01-02', process_date: '2026-01-02',
  amount: '1.00', currency: 'USD', status: 'posted', merchant: null, transaction_type: 'purchase',
  channel: 'card', product: 'fixture',
};
const status = { service: 'banking-mcp', version: '1.0', read_only: true, mode: 'delegated',
  dataset_ready: true, customer_assertion_required: true, customer_selection_required: false,
  conversation_correlation_required: false, source_verification_configured: false,
  tools: ['banking_status', 'list_my_transactions', 'get_my_transaction'] };
const list = { transactions: [{ ...transaction, selection_handle: 'a'.repeat(32) }], next_cursor: null,
  date_window: { start: '2026-01-01', end: '2026-01-31', basis: 'process_date' }, snapshot: 'fixture_snapshot',
  freshness: 'derived_snapshot', read_only: true, synthetic: false, operator_test: false };
const get = { transaction, snapshot: 'fixture_snapshot', freshness: 'derived_snapshot',
  read_only: true, synthetic: false, operator_test: false };
function response(data: object, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
    ...(isError === undefined ? {} : { isError }) };
}

describe('delegated Python banking result contract', () => {
  test.each([['banking_status', status], ['list_my_transactions', list], ['get_my_transaction', get],
    ['get_my_transaction', { ...get, freshness: 'verified_against_pinned_source' }]])(
    'accepts the complete delegated %s response and preserves its public fields', (tool, data) => {
      expect(validateBankingResult(tool as string, response(data as object))).toEqual({
        content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
      });
    });

  test.each([
    ['banking_status', { ...status, customer_selection_required: true }],
    ['banking_status', { ...status, conversation_correlation_required: true }],
    ['banking_status', { ...status, customer_assertion_required: false }],
    ['banking_status', { ...status, mode: 'operator-test' }],
    ['list_my_transactions', { ...list, operator_test: true }],
    ['get_my_transaction', { ...get, operator_test: true }],
    ['list_my_transactions', { ...list, synthetic: true }],
    ['get_my_transaction', { ...get, synthetic: true }],
    ['banking_status', { ...status, unknown: false }],
    ['list_my_transactions', { ...list, customer_id: 'foreign' }],
    ['get_my_transaction', { ...get, transaction: { ...transaction, customer_id: 'foreign' } }],
  ])('rejects operator or unexpected data for %s', (tool, data) => {
    expect(() => validateBankingResult(tool as string, response(data as object)))
      .toThrow('banking_protocol_result_rejected');
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
