import { resolveAutoNodeLabel } from '@/shared/utils/nodeLabel';

// FlowBuilder node auto-naming state machine (issue #38, Item C).
describe('resolveAutoNodeLabel', () => {
  const PROCESS_DEFAULT = 'Process Node';
  const MCP_DEFAULT = 'MCP Node';

  it('auto-names a fresh node still on its factory default', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: PROCESS_DEFAULT,
        defaultLabel: PROCESS_DEFAULT,
        nextAutoLabel: 'Claude (opus)',
      }),
    ).toBe('Claude (opus)');
  });

  it('auto-names an empty label', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: '',
        defaultLabel: MCP_DEFAULT,
        nextAutoLabel: 'filesystem',
      }),
    ).toBe('filesystem');
  });

  it('re-updates on a SECOND binding when the label still matches the previous auto name (the reported bug)', () => {
    // Node was auto-named "Claude (opus)" on the first bind; switching models
    // must now re-label it, which the old prev === default check never did.
    expect(
      resolveAutoNodeLabel({
        currentLabel: 'Claude (opus)',
        defaultLabel: PROCESS_DEFAULT,
        previousAutoLabel: 'Claude (opus)',
        nextAutoLabel: 'GPT-4o',
      }),
    ).toBe('GPT-4o');
  });

  it('preserves a name the user typed by hand (nameIsCustom flag)', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: 'Router',
        nameIsCustom: true,
        defaultLabel: PROCESS_DEFAULT,
        previousAutoLabel: 'Claude (opus)',
        nextAutoLabel: 'GPT-4o',
      }),
    ).toBe('Router');
  });

  it('preserves a custom name on legacy nodes (no flag) that differ from default and previous auto name', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: 'My Orchestrator',
        defaultLabel: PROCESS_DEFAULT,
        previousAutoLabel: 'Claude (opus)',
        nextAutoLabel: 'GPT-4o',
      }),
    ).toBe('My Orchestrator');
  });

  it('MCP node adopts the newly-bound server name when unnamed', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: MCP_DEFAULT,
        defaultLabel: MCP_DEFAULT,
        previousAutoLabel: 'github',
        nextAutoLabel: 'filesystem',
      }),
    ).toBe('filesystem');
  });

  it('falls back to the next auto name when a custom label is somehow empty', () => {
    expect(
      resolveAutoNodeLabel({
        currentLabel: '',
        nameIsCustom: true,
        defaultLabel: PROCESS_DEFAULT,
        nextAutoLabel: 'GPT-4o',
      }),
    ).toBe('GPT-4o');
  });
});
