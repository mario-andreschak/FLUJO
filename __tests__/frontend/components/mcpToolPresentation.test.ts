import {
  getMCPToolDisplayName,
  getMCPToolSection,
  groupMCPTools,
  MCPToolUsesBehaviorDefaults,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/mcpToolPresentation';

const tool = (name: string, annotations?: Record<string, unknown>, title?: string) => ({
  name,
  title,
  inputSchema: { type: 'object' as const },
  annotations,
}) as any;

describe('MCP tool presentation', () => {
  it('uses the MCP display-name precedence', () => {
    expect(getMCPToolDisplayName(tool('technical', { title: 'Legacy title' }, 'Friendly title'))).toBe('Friendly title');
    expect(getMCPToolDisplayName(tool('technical', { title: 'Legacy title' }))).toBe('Legacy title');
    expect(getMCPToolDisplayName(tool('technical'))).toBe('technical');
  });

  it('groups read-only, destructive-default, and additive tools according to MCP defaults', () => {
    const read = tool('read', { readOnlyHint: true, destructiveHint: true });
    const remove = tool('remove', { destructiveHint: true });
    const legacy = tool('legacy');
    const create = tool('create', { destructiveHint: false });

    expect(getMCPToolSection(read)).toBe('readOnly');
    expect(getMCPToolSection(remove)).toBe('destructive');
    expect(getMCPToolSection(legacy)).toBe('destructive');
    expect(getMCPToolSection(create)).toBe('otherChanges');
    expect(groupMCPTools([read, remove, legacy, create]).map((section) => [
      section.key,
      section.tools.map((entry) => entry.name),
    ])).toEqual([
      ['readOnly', ['read']],
      ['destructive', ['remove', 'legacy']],
      ['otherChanges', ['create']],
    ]);
    expect(MCPToolUsesBehaviorDefaults(legacy)).toBe(true);
    expect(MCPToolUsesBehaviorDefaults(create)).toBe(true);
    expect(MCPToolUsesBehaviorDefaults(read)).toBe(false);
  });
});
