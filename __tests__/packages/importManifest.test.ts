/**
 * Re-importing an exported manifest back into the creation wizard: the draft
 * must restore the selection/metadata/secret names, and drop (but report)
 * entities that no longer exist on the host.
 */
import { packageToWizardDraft, parseImportedPackage } from '@/shared/types/package/package.import';
import type { FlujoPackage } from '@/shared/types/package/package';

const manifest = (): FlujoPackage => ({
  schemaVersion: 1,
  id: 'pkg-1',
  name: 'Demo package',
  version: '1.2.3',
  description: 'a demo',
  tags: ['demo', 'test'],
  secrets: [
    { name: 'MODEL_GPT_API_KEY', required: true },
    { name: 'HOME_PATH', required: true },
  ],
  models: [
    { id: 'model-1', name: 'gpt-4', displayName: 'GPT 4', apiKeyRef: { kind: 'secret', secret: 'MODEL_GPT_API_KEY' } },
    { id: 'model-gone', name: 'old', displayName: 'Old model', apiKeyRef: { kind: 'none' } },
  ],
  mcpServers: [],
  flows: [
    { flow: { id: 'flow-1', name: 'Main', nodes: [], edges: [] } as never },
    { flow: { id: 'flow-gone', name: 'Deleted', nodes: [], edges: [] } as never },
  ],
  plannedExecutions: [
    {
      id: 'pe-1',
      name: 'Nightly',
      enabled: false,
      flowId: 'flow-1',
      prompt: 'go',
      trigger: { type: 'manual' },
    } as never,
  ],
});

const available = {
  flowIds: ['flow-1', 'flow-other'],
  modelIds: ['model-1'],
  mcpServerNames: ['server-a'],
  plannedExecutionIds: ['pe-1'],
};

describe('packageToWizardDraft', () => {
  it('restores the selection, metadata and secret names', () => {
    const draft = packageToWizardDraft(manifest(), available);

    expect(draft.selection).toEqual({
      flowIds: ['flow-1'],
      modelIds: ['model-1'],
      mcpServerNames: [],
      plannedExecutionIds: ['pe-1'],
    });
    expect(draft.metadata).toEqual({
      name: 'Demo package',
      version: '1.2.3',
      description: 'a demo',
      tags: ['demo', 'test'],
    });
    expect(draft.secretNames).toEqual(['MODEL_GPT_API_KEY', 'HOME_PATH']);
  });

  it('reports entities that no longer exist instead of selecting them', () => {
    const draft = packageToWizardDraft(manifest(), available);

    expect(draft.missing).toEqual([
      { type: 'flow', label: 'Deleted (flow-gone)' },
      { type: 'model', label: 'Old model' },
    ]);
  });

  it('handles a manifest with no optional collections', () => {
    const bare: FlujoPackage = {
      schemaVersion: 1,
      id: 'pkg-2',
      name: 'Bare',
      version: '0.1.0',
      secrets: [],
      models: [],
      mcpServers: [],
      flows: [],
      plannedExecutions: [],
    };
    const draft = packageToWizardDraft(bare, available);
    expect(draft.selection.flowIds).toEqual([]);
    expect(draft.metadata).toEqual({ name: 'Bare', version: '0.1.0', description: '', tags: [] });
    expect(draft.missing).toEqual([]);
  });
});

describe('parseImportedPackage', () => {
  it('accepts an exported manifest', () => {
    const result = parseImportedPackage(JSON.stringify(manifest()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.package.name).toBe('Demo package');
  });

  it('rejects malformed JSON without throwing', () => {
    const result = parseImportedPackage('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Not valid JSON/);
  });

  it('rejects JSON that is not a package manifest', () => {
    const result = parseImportedPackage(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});
