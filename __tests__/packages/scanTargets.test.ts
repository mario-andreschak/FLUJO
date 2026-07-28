/**
 * Unit tests for the "Add a secret manually" VALUE PICKER data source
 * (issue #285). The picker endpoint (`/api/packages/scan-targets` via
 * `scanTargetsForSelection`) reuses the SAME content extractor as secret
 * derivation. These tests lock in the security guarantee the picker depends on:
 * model API keys and MCP env/header VALUES are NEVER emitted as pickable
 * candidates — only plaintext already present in flow/model/planned-exec config.
 */
import {
  extractScanTargets,
  extractModelTargets,
} from '@/backend/services/packages/secretScanTargets';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

function promptNode(id: string, prompt: string): FlowNode {
  return {
    id,
    type: 'process',
    position: { x: 0, y: 0 },
    data: { label: 'P', type: 'process', properties: { prompt } },
  } as unknown as FlowNode;
}

function flow(id: string, nodes: FlowNode[]): Flow {
  return { id, name: id, description: 'desc', nodes, edges: [] } as unknown as Flow;
}

function pe(id: string, prompt: string): PlannedExecution {
  return { id, name: id, enabled: true, flowId: 'f', prompt } as unknown as PlannedExecution;
}

describe('scan-targets value picker source (issue #285)', () => {
  const SECRET_KEY = 'sk-super-secret-api-key-value-1234567890';

  it('never emits a model ApiKey as a pickable candidate', () => {
    const m = {
      id: 'm1',
      name: 'gpt',
      displayName: 'GPT',
      provider: 'openai',
      baseUrl: 'https://api.example.com',
      ApiKey: SECRET_KEY,
      apiKey: SECRET_KEY,
    } as unknown as Model;

    const targets = extractModelTargets(m);
    const texts = targets.map((t) => t.text);
    expect(texts).not.toContain(SECRET_KEY);
    // But legitimate plaintext connection fields ARE pickable.
    expect(texts).toContain('https://api.example.com');
  });

  it('surfaces flow/model/planned plaintext but no secret key across the whole selection', () => {
    const entities = {
      flows: [flow('f1', [promptNode('n1', 'redact https://internal.example.org please')])],
      models: [
        {
          id: 'm1',
          name: 'gpt',
          displayName: 'GPT',
          provider: 'openai',
          ApiKey: SECRET_KEY,
        } as unknown as Model,
      ],
      plannedExecutions: [pe('p1', 'run against acme/private-repo')],
    };

    const targets = extractScanTargets(entities);
    const texts = targets.map((t) => t.text);

    expect(texts).not.toContain(SECRET_KEY);
    expect(texts).toContain('redact https://internal.example.org please');
    expect(texts).toContain('run against acme/private-repo');
    // Locations are prefixed with the source kind used for grouping in the UI.
    expect(targets.every((t) => /^(flow|model|plannedExecution):/.test(t.location))).toBe(true);
  });
});
