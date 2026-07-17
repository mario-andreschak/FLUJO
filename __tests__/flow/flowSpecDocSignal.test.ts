/**
 * Doc-contract guard (issue #132): the FlowSpec DSL text the generator LLM, the MCP
 * authoring tools, and the /docs reference all share (`FLOWSPEC_DOC`) MUST advertise the
 * `signal` node type. The signal machinery (emit/compile/validate/round-trip) shipped with
 * issue #117, but the authoring doc never mentioned it, so the generator could never emit a
 * signal node. This test locks the contract so the node type can't silently disappear from
 * the doc again.
 */
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';

describe('FLOWSPEC_DOC — signal node contract (issue #132)', () => {
  it('documents the signal node type in NODE TYPES', () => {
    expect(FLOWSPEC_DOC).toContain('"type": "signal"');
  });

  it('documents the required topic field and optional payloadTemplate', () => {
    expect(FLOWSPEC_DOC).toContain('"topic"');
    expect(FLOWSPEC_DOC).toContain('"payloadTemplate"');
  });

  it('explains when/why to use a signal (RULES entry)', () => {
    // A rule mentioning signals so the model knows the intent, not just the shape.
    expect(FLOWSPEC_DOC.toLowerCase()).toContain('signal');
    expect(FLOWSPEC_DOC).toMatch(/flow-run event bus|flow-event trigger/i);
  });
});
