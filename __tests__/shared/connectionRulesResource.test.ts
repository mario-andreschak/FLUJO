/**
 * Tier 3 — connection rules for the resource node type.
 *
 * Pins the legality matrix (resource ↔ process only, via resource handles),
 * the attachment-edge classifier every control-flow discrimination relies on,
 * the pane-drop defaults (resource wiring lands on resource handles, never
 * `-top`), and that the existing MCP rules are untouched.
 */
import {
  getConnectionError,
  isResourceHandle,
  isMcpHandle,
  isAttachmentEdge,
  defaultTargetHandleFor,
  validTargetTypesFor,
} from '@/utils/shared/connectionRules';

describe('handle classifiers', () => {
  it('isResourceHandle matches resource handles only', () => {
    expect(isResourceHandle('resource-in')).toBe(true);
    expect(isResourceHandle('resource-out')).toBe(true);
    expect(isResourceHandle('process-left-resource')).toBe(true);
    expect(isResourceHandle('process-right-resource')).toBe(true);
    expect(isResourceHandle('process-left-mcp')).toBe(false);
    expect(isResourceHandle('process-bottom')).toBe(false);
    expect(isResourceHandle(null)).toBe(false);
  });

  it('resource handles never collide with the mcp classifier', () => {
    for (const id of ['resource-in', 'resource-out', 'process-left-resource', 'process-right-resource']) {
      expect(isMcpHandle(id)).toBe(false);
    }
  });

  it('isAttachmentEdge covers mcp and resource, not control', () => {
    expect(isAttachmentEdge({ data: { edgeType: 'mcp' } })).toBe(true);
    expect(isAttachmentEdge({ data: { edgeType: 'resource' } })).toBe(true);
    expect(isAttachmentEdge({ data: { edgeType: 'standard' } })).toBe(false);
    expect(isAttachmentEdge({ data: {} })).toBe(false);
    expect(isAttachmentEdge({})).toBe(false);
  });
});

describe('getConnectionError — resource matrix', () => {
  it('allows resource → process on resource handles (consume)', () => {
    expect(getConnectionError('resource', 'resource-out', 'process', 'process-left-resource')).toBeNull();
  });

  it('allows process → resource on resource handles (produce)', () => {
    expect(getConnectionError('process', 'process-right-resource', 'resource', 'resource-in')).toBeNull();
  });

  it('rejects resource ↔ non-process pairs', () => {
    expect(getConnectionError('resource', 'resource-out', 'finish', 'finish-top')).toContain('Resource connections');
    expect(getConnectionError('resource', 'resource-out', 'subflow', 'subflow-top')).toContain('Resource connections');
    expect(getConnectionError('resource', 'resource-out', 'resource', 'resource-in')).toContain('Resource connections');
    expect(getConnectionError('start', 'start-bottom', 'resource', 'resource-in')).toContain('Resource connections');
  });

  it('rejects resource ↔ mcp (the mcp rule wins and requires an mcp/process pair)', () => {
    expect(getConnectionError('resource', 'resource-out', 'mcp', 'mcp-left')).not.toBeNull();
  });

  it('requires the process side to use a resource handle', () => {
    expect(getConnectionError('process', 'process-bottom', 'resource', 'resource-in'))
      .toContain('left/right resource handles');
  });

  it('start/finish guards still fire first', () => {
    expect(getConnectionError('resource', 'resource-out', 'start', 'start-bottom'))
      .toContain('Start nodes');
    expect(getConnectionError('finish', 'finish-top', 'resource', 'resource-in'))
      .toContain('Finish nodes');
  });

  it('existing MCP rules are unchanged', () => {
    expect(getConnectionError('process', 'process-right-mcp', 'mcp', 'mcp-left')).toBeNull();
    expect(getConnectionError('mcp', 'mcp-bottom', 'process', 'process-left-mcp')).toBeNull();
    expect(getConnectionError('process', 'process-bottom', 'mcp', 'mcp-top')).not.toBeNull();
    expect(getConnectionError('process', 'process-bottom', 'process', 'process-top')).toBeNull();
  });
});

describe('pane-drop defaults', () => {
  it('resource targets land on resource-in', () => {
    expect(defaultTargetHandleFor('resource', 'process-right-resource')).toBe('resource-in');
  });

  it('a drag from resource-out lands on the process resource input', () => {
    expect(defaultTargetHandleFor('process', 'resource-out')).toBe('process-left-resource');
  });

  it('flow-control defaults unchanged', () => {
    expect(defaultTargetHandleFor('process', 'start-bottom')).toBe('process-top');
    expect(defaultTargetHandleFor('finish', 'process-bottom')).toBe('finish-top');
  });

  it('validTargetTypesFor offers process from resource-out, resource from process-right-resource', () => {
    expect(validTargetTypesFor('resource', 'resource-out')).toEqual(['process']);
    expect(validTargetTypesFor('process', 'process-right-resource')).toEqual(['resource']);
    // MCP drags still offer only mcp.
    expect(validTargetTypesFor('process', 'process-right-mcp')).toEqual(['mcp']);
  });
});
