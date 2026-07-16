/**
 * Tier 3 — ResourceHandler.processResourceNodes (the consume-edge runtime).
 *
 * Pins: static MCP resources read via mcpService and inlined; run artifacts
 * read by name with lineage; binary rendered as a stub; produce-role nodes
 * skipped; resource:read emitted with the RESOURCE node's id (canvas
 * attribution); failures render notes and never throw.
 */

const readResourceMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: { readResource: (...args: unknown[]) => readResourceMock(...args) },
}));

const findByNameMock = jest.fn();
const readRunMock = jest.fn();
jest.mock('@/backend/services/runResources', () => ({
  findRunResourceByName: (...args: unknown[]) => findByNameMock(...args),
  readRunResource: (...args: unknown[]) => readRunMock(...args),
}));

import { ResourceHandler } from '@/backend/execution/flow/handlers/ResourceHandler';
import type { ResourceNodeReference } from '@/backend/execution/flow/types';

const mcpRef: ResourceNodeReference = {
  id: 'res-node-1',
  role: 'consume',
  properties: { name: 'Spec', scope: 'mcp', boundServer: 'files', uri: 'file:///spec.md' },
};

const runRef: ResourceNodeReference = {
  id: 'res-node-2',
  role: 'consume',
  properties: { name: 'Report', scope: 'run', runName: 'report' },
};

beforeEach(() => {
  readResourceMock.mockReset();
  findByNameMock.mockReset();
  readRunMock.mockReset();
});

describe('ResourceHandler.processResourceNodes', () => {
  it('returns empty for no consume nodes (produce-only is skipped)', async () => {
    expect(await ResourceHandler.processResourceNodes({ resourceNodes: [] })).toBe('');
    expect(await ResourceHandler.processResourceNodes({
      resourceNodes: [{ ...runRef, role: 'produce' }],
    })).toBe('');
    expect(readResourceMock).not.toHaveBeenCalled();
  });

  it('inlines a static MCP resource and emits resource:read attributed to the resource NODE', async () => {
    readResourceMock.mockResolvedValue({
      success: true,
      data: { contents: [{ uri: 'file:///spec.md', mimeType: 'text/markdown', text: '# THE SPEC' }] },
    });
    const emit = jest.fn();

    const block = await ResourceHandler.processResourceNodes({ resourceNodes: [mcpRef], emit });

    expect(block).toContain('## Resources');
    expect(block).toContain('# THE SPEC');
    expect(readResourceMock).toHaveBeenCalledWith('files', 'file:///spec.md');
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:read',
      source: 'node',
      server: 'files',
      uri: 'file:///spec.md',
      node: expect.objectContaining({ nodeId: 'res-node-1', nodeType: 'resource' }),
    }));
  });

  it('reads a run artifact by name with lineage', async () => {
    const entry = {
      id: 'r1', uri: 'flujo://run/conv-1/r1', conversationId: 'conv-1', name: 'report',
      mimeType: 'text/markdown', size: 8, kind: 'text', encoding: 'utf8', createdAt: 1,
      producedBy: { source: 'capture' }, readBy: [],
    };
    findByNameMock.mockResolvedValue(entry);
    readRunMock.mockResolvedValue({
      entry,
      contents: { contents: [{ uri: entry.uri, text: 'CONTENTS' }] },
    });
    const emit = jest.fn();

    const block = await ResourceHandler.processResourceNodes({
      resourceNodes: [runRef], conversationId: 'conv-1', emit,
    });

    expect(block).toContain('CONTENTS');
    expect(findByNameMock).toHaveBeenCalledWith('conv-1', 'report');
    expect(readRunMock).toHaveBeenCalledWith(entry.uri, expect.objectContaining({ source: 'node', nodeId: 'res-node-2' }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'resource:read', source: 'node', uri: entry.uri, name: 'report',
    }));
  });

  it('an unproduced run artifact renders a note, not an error', async () => {
    findByNameMock.mockResolvedValue(null);
    const block = await ResourceHandler.processResourceNodes({
      resourceNodes: [runRef], conversationId: 'conv-1',
    });
    expect(block).toContain('has not been produced yet');
  });

  it('binary contents become a stub, never inlined base64', async () => {
    readResourceMock.mockResolvedValue({
      success: true,
      data: { contents: [{ uri: 'file:///img.png', mimeType: 'image/png', blob: 'QUJDRA==' }] },
    });
    const block = await ResourceHandler.processResourceNodes({ resourceNodes: [mcpRef] });
    expect(block).not.toContain('QUJDRA==');
    expect(block).toContain('image/png');
    expect(block).toContain('resources/read');
  });

  it('read failures and throws render notes and never break prep', async () => {
    readResourceMock.mockResolvedValueOnce({ success: false, error: 'gone' });
    let block = await ResourceHandler.processResourceNodes({ resourceNodes: [mcpRef] });
    expect(block).toContain('could not be read');

    readResourceMock.mockRejectedValueOnce(new Error('boom'));
    block = await ResourceHandler.processResourceNodes({ resourceNodes: [mcpRef] });
    expect(block).toContain('currently unavailable');
  });
});
