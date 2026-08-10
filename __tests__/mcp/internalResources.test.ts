/**
 * Tier 3 — the internal "flujo" server's resources capability.
 *
 * internalListResources / internalListResourceTemplates / internalReadResource
 * serve the run-resource store over MCP shapes. Pins: listing carries name/
 * mime/producer description, the RFC-6570 template is published, reads return
 * MCP contents + append readBy lineage + announce a resource:read on the
 * owning conversation's live bus, and unknown/foreign URIs map to 404/400.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: jest.fn(),
}));

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  listPersonaFlowDispatches: jest.fn(),
}));

import {
  internalListResources,
  internalListResourceTemplates,
  internalReadResource,
} from '@/backend/services/mcp/internalResources';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { listPersonaFlowDispatches } from '@/backend/services/enduringAgents/personaDispatcher';
import {
  writeRunResource,
  readRunResource,
  _setRunResourcesDirForTests,
} from '@/backend/services/runResources';
import type { RunResourceEntry } from '@/shared/types/runResources';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import type { ExecutionEvent } from '@/shared/types/execution/events';

let tmpDir: string;
let previousDir: string;
let entry: RunResourceEntry;
let personaEntry: RunResourceEntry;
let ephemeralPersonaEntry: RunResourceEntry;
let personaConversationMarkers: Record<string, unknown>;

const loadConversationStateMock = loadConversationState as jest.Mock;
const listPersonaFlowDispatchesMock = listPersonaFlowDispatches as jest.Mock;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-intres-'));
  previousDir = _setRunResourcesDirForTests(tmpDir);
  entry = await writeRunResource({
    conversationId: 'conv-int',
    name: 'summary',
    mimeType: 'text/markdown',
    kind: 'text',
    data: { text: '# summary' },
    producedBy: { source: 'tool-result', server: 'srv', toolName: 'analyze', toolCallId: 'c1', nodeId: 'n1' },
  }) as RunResourceEntry;
  personaEntry = await writeRunResource({
    conversationId: 'conv-persona',
    name: 'private-summary',
    mimeType: 'text/plain',
    kind: 'text',
    data: { text: 'private Persona output' },
    producedBy: { source: 'capture', nodeId: 'private-node' },
  }) as RunResourceEntry;
  ephemeralPersonaEntry = await writeRunResource({
    conversationId: 'conv-persona-ephemeral',
    name: 'ephemeral-private-summary',
    mimeType: 'text/plain',
    kind: 'text',
    data: { text: 'private ephemeral Persona output' },
    producedBy: { source: 'capture', nodeId: 'ephemeral-private-node' },
  }) as RunResourceEntry;
});

beforeEach(() => {
  listPersonaFlowDispatchesMock.mockReset().mockResolvedValue([]);
  personaConversationMarkers = {
    personaAttribution: {
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    },
  };
  loadConversationStateMock.mockImplementation(async (conversationId: string) =>
    conversationId === 'conv-persona'
      ? {
          conversationId,
          ...personaConversationMarkers,
        }
      : undefined,
  );
});

afterAll(async () => {
  _setRunResourcesDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('internalListResources', () => {
  it('lists run resources with identity + producer description', async () => {
    const { resources, error } = await internalListResources();
    expect(error).toBeUndefined();
    const found = resources.find((r) => r.uri === entry.uri);
    expect(found).toBeDefined();
    expect(found!.name).toBe('summary');
    expect(found!.mimeType).toBe('text/markdown');
    expect(found!.description).toContain('srv/analyze');
  });

  it('rejects malformed pagination cursors without throwing the MCP request', async () => {
    const result = await internalListResources('not-a-real-cursor');
    expect(result.resources).toEqual([]);
    expect(result.error).toContain('cursor');
  });

  it('filters Persona-owned resources before returning MCP list entries', async () => {
    const result = await internalListResources();
    expect(result.error).toBeUndefined();
    expect(result.resources.some((resource) => resource.uri === entry.uri)).toBe(true);
    expect(result.resources.some((resource) => resource.uri === personaEntry.uri)).toBe(false);
  });

  it('uses one lazy durable-dispatch scan to filter ephemeral Persona resources', async () => {
    listPersonaFlowDispatchesMock.mockResolvedValue([{
      flowInput: { conversationId: 'conv-persona-ephemeral' },
    }]);

    const result = await internalListResources();

    expect(result.error).toBeUndefined();
    expect(result.resources.some((resource) => resource.uri === ephemeralPersonaEntry.uri)).toBe(false);
    expect(listPersonaFlowDispatchesMock).toHaveBeenCalledTimes(1);
  });
});

describe('internalListResourceTemplates', () => {
  it('publishes the run-resource URI template', () => {
    const { resourceTemplates } = internalListResourceTemplates();
    expect(resourceTemplates).toHaveLength(1);
    expect(resourceTemplates[0].uriTemplate).toBe('flujo://run/{conversationId}/{resourceId}');
  });
});

describe('internalReadResource', () => {
  it('serves contents, appends readBy lineage, and announces on the live bus', async () => {
    const events: ExecutionEvent[] = [];
    const unsubscribe = executionEventBus.subscribe('conv-int', (e) => events.push(e));
    try {
      const result = await internalReadResource(entry.uri);
      expect(result.success).toBe(true);
      expect(result.data!.contents[0]).toMatchObject({ uri: entry.uri, text: '# summary' });

      // Lineage appended (source mcp-read).
      const reread = await readRunResource(entry.uri);
      expect(reread!.entry.readBy.some((a) => a.source === 'mcp-read')).toBe(true);

      // The read was announced on the owning conversation's event stream.
      const readEvents = events.filter((e) => e.type === 'resource:read');
      expect(readEvents).toHaveLength(1);
      expect(readEvents[0]).toMatchObject({
        type: 'resource:read',
        server: 'flujo',
        uri: entry.uri,
        name: 'summary',
        source: 'mcp-read',
      });
    } finally {
      unsubscribe();
    }
  });

  it('unknown URIs → 404, foreign URIs → 400', async () => {
    const missing = await internalReadResource('flujo://run/conv-int/does-not-exist');
    expect(missing.success).toBe(false);
    expect(missing.statusCode).toBe(404);

    const foreign = await internalReadResource('file:///etc/passwd');
    expect(foreign.success).toBe(false);
    expect(foreign.statusCode).toBe(400);
  });

  it('rejects Persona-owned payloads before lineage or event side effects', async () => {
    const events: ExecutionEvent[] = [];
    const unsubscribe = executionEventBus.subscribe('conv-persona', (event) => events.push(event));
    try {
      const before = await readRunResource(personaEntry.uri);
      expect(before?.entry.readBy).toEqual([]);

      const result = await internalReadResource(personaEntry.uri);
      expect(result).toMatchObject({ success: false, statusCode: 403 });
      expect(result.error).toContain('Persona');

      const after = await readRunResource(personaEntry.uri);
      expect(after?.entry.readBy).toEqual([]);
      expect(events.filter((event) => event.type === 'resource:read')).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['pending target', { personaTargetId: 'persona-1' }],
    ['frozen instruction context', { personaInstructionContext: { personaId: 'persona-1' } }],
    ['corrupt null attribution', { personaAttribution: null }],
    ['corrupt empty target', { personaTargetId: '' }],
  ])('does not list or read resources for %s ownership markers', async (_label, markers) => {
    personaConversationMarkers = markers;

    const listed = await internalListResources();
    expect(listed.resources.some((resource) => resource.uri === personaEntry.uri)).toBe(false);

    const before = await readRunResource(personaEntry.uri);
    expect(before?.entry.readBy).toEqual([]);
    const result = await internalReadResource(personaEntry.uri);
    expect(result).toMatchObject({ success: false, statusCode: 403 });
    const after = await readRunResource(personaEntry.uri);
    expect(after?.entry.readBy).toEqual([]);
  });

  it('rejects an ephemeral Persona resource owned by a durable dispatch outcome', async () => {
    listPersonaFlowDispatchesMock.mockResolvedValue([{
      outcome: { conversationId: 'conv-persona-ephemeral' },
    }]);
    const before = await readRunResource(ephemeralPersonaEntry.uri);
    expect(before?.entry.readBy).toEqual([]);

    const result = await internalReadResource(ephemeralPersonaEntry.uri);

    expect(result).toMatchObject({ success: false, statusCode: 403 });
    const after = await readRunResource(ephemeralPersonaEntry.uri);
    expect(after?.entry.readBy).toEqual([]);
    expect(listPersonaFlowDispatchesMock).toHaveBeenCalledTimes(1);
  });
});
