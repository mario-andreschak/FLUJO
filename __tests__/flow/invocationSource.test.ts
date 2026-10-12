import {
  FLOW_INVOCATION_SOURCES,
  isFlowInvocationSource,
  isUnattendedFlowInvocation,
} from '@/shared/types/execution/invocation';
import * as backend from '@/backend/execution/flow/types';

describe('shared invocation source contract', () => {
  it.each([
    ['chat', false], ['api', false], ['schedule', true], ['trigger', true],
    ['subflow', true], ['mcp', true], ['internal', true], ['meeting', true],
  ] as const)('keeps %s unattended=%s', (source, unattended) => {
    expect(isFlowInvocationSource(source)).toBe(true);
    expect(isUnattendedFlowInvocation(source)).toBe(unattended);
  });

  it.each([undefined, null, 1, {}, ['chat'], 'CHAT', ' chat', '', 'unknown']) (
    'rejects non-contract source %p', (source) => expect(isFlowInvocationSource(source)).toBe(false),
  );

  it('retains the backend interface as the same shared implementation', () => {
    expect(backend.FLOW_INVOCATION_SOURCES).toBe(FLOW_INVOCATION_SOURCES);
    expect(backend.isFlowInvocationSource).toBe(isFlowInvocationSource);
    expect(backend.isUnattendedFlowInvocation).toBe(isUnattendedFlowInvocation);
  });
});
