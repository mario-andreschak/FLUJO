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
import {
  internalListResources,
  internalListResourceTemplates,
  internalReadResource,
} from '@/backend/services/mcp/internalResources';
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
});
