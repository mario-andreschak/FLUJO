import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';

describe('FLOWSPEC_DOC — Subflow queue contract', () => {
  it('documents one child, repeated queued handoffs, and bounded active workers', () => {
    expect(FLOWSPEC_DOC).toContain('references exactly ONE child');
    expect(FLOWSPEC_DOC).toContain('may call the SAME subflow handoff tool any number of times');
    expect(FLOWSPEC_DOC).toContain('NEVER limits the total jobs accepted');
    expect(FLOWSPEC_DOC).toContain('terminal subflow invoked from a Process node returns');
  });

  it('does not advertise legacy execution-shape fields in the Subflow schema', () => {
    expect(FLOWSPEC_DOC).not.toContain('"parallelFlows":');
    expect(FLOWSPEC_DOC).not.toContain('"parallelSubflowSpecs":');
    expect(FLOWSPEC_DOC).not.toContain('"mapOverList":');
    expect(FLOWSPEC_DOC).not.toContain('"spawnBriefs":');
    expect(FLOWSPEC_DOC).not.toContain('"allowCallerFanout":');
    expect(FLOWSPEC_DOC).toContain('saved FlowSpecs');
  });
});
