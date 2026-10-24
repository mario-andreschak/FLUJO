import {
  automationAiGate, withoutLegacyAiGate, validateAutomationAiGate,
  type AutomationAiGate, type TriggerConfig,
} from '@/shared/types/plannedExecution';

const gate: AutomationAiGate = {
  mode: 'flow-gate', condition: 'Only urgent invoices', flowId: 'checker', maxCallsPerDay: 20,
};
const legacy: TriggerConfig = {
  type: 'mcp-poll', serverName: 'mail', toolName: 'inbox', args: {}, evaluate: gate,
};

it('retains a legacy checker when moving it to the shared condition', () => {
  expect(automationAiGate({ trigger: legacy })).toEqual(gate);
  expect(withoutLegacyAiGate(legacy)).toEqual({ ...legacy, evaluate: { mode: 'on-change' } });
  expect(automationAiGate({ trigger: legacy, aiGate: null })).toBeNull();
});

it.each<TriggerConfig>([
  { type: 'schedule', cron: '0 9 * * *' },
  { type: 'webhook', token: 'secret' },
  { type: 'file-watch', path: '/watch', events: ['change'] },
  { type: 'url-watch', url: 'https://example.com', cron: '0 9 * * *' },
  { type: 'flow-event', source: { flowId: 'upstream' }, on: ['completed'] },
  { ...legacy, evaluate: { mode: 'new-items', idField: 'id', itemsPath: 'items' } },
])('keeps the condition independent of $type settings', trigger => {
  expect(automationAiGate({ trigger, aiGate: gate })).toEqual(gate);
  expect(withoutLegacyAiGate(trigger)).toEqual(trigger);
});

it.each([
  false, [], {}, { ...gate, mode: 'unknown' }, { ...gate, condition: '' },
  { ...gate, flowId: 7 }, { ...gate, maxCallsPerDay: 0 },
  { ...gate, maxCallsPerDay: 1.5 }, { ...gate, maxCallsPerDay: Infinity },
])('rejects malformed API conditions %#', value => {
  expect(validateAutomationAiGate(value)).not.toBeNull();
});

it('accepts both checker types and a disabled condition', () => {
  for (const value of [gate, null, undefined, { mode: 'llm-gate', condition: 'ready', modelId: 'model' }]) {
    expect(validateAutomationAiGate(value)).toBeNull();
  }
});
