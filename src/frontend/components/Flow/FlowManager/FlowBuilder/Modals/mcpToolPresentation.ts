import type { MCPToolResponse } from '@/shared/types/mcp';

export type MCPToolSectionKey = 'readOnly' | 'destructive' | 'otherChanges';

export interface MCPToolSection {
  key: MCPToolSectionKey;
  tools: MCPToolResponse[];
}

/**
 * MCP's display-name precedence is `title`, then the legacy annotation title,
 * then the programmatic name. Keeping it in one helper avoids showing technical
 * identifiers when a server has supplied a friendlier label.
 */
export function getMCPToolDisplayName(tool: MCPToolResponse): string {
  return tool.title?.trim() || tool.annotations?.title?.trim() || tool.name;
}

/**
 * Put a tool into one mutually-exclusive, user-facing behavior section.
 *
 * MCP deliberately uses cautious defaults: an omitted readOnlyHint is false
 * and, for a tool that changes state, an omitted destructiveHint is true.
 * readOnlyHint wins when a server sends the otherwise-inconsistent combination
 * of readOnly=true and destructive=true because destructiveHint is meaningful
 * only for non-read-only tools.
 */
export function getMCPToolSection(tool: MCPToolResponse): MCPToolSectionKey {
  if (tool.annotations?.readOnlyHint === true) return 'readOnly';
  if (tool.annotations?.destructiveHint === false) return 'otherChanges';
  return 'destructive';
}

export function groupMCPTools(tools: MCPToolResponse[]): MCPToolSection[] {
  const grouped: Record<MCPToolSectionKey, MCPToolResponse[]> = {
    readOnly: [],
    destructive: [],
    otherChanges: [],
  };

  for (const tool of tools) grouped[getMCPToolSection(tool)].push(tool);

  return (['readOnly', 'destructive', 'otherChanges'] as const)
    .map((key) => ({ key, tools: grouped[key] }))
    .filter((section) => section.tools.length > 0);
}

export function MCPToolUsesBehaviorDefaults(tool: MCPToolResponse): boolean {
  const annotations = tool.annotations;
  return annotations?.readOnlyHint === undefined
    || (annotations.readOnlyHint !== true && annotations.destructiveHint === undefined);
}
