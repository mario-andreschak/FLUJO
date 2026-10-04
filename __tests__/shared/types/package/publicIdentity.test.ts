import { validatePackage } from '@/shared/types/package/package.serialize';

const message = 'Package identities and public labels cannot contain secret placeholders';
const placeholder = 'prefix-{{secret.API_KEY}}-suffix';
const manifest = () => ({
  schemaVersion: 1, id: 'package-id', name: 'Public Package', version: '1.0.0',
  secrets: [{ name: 'API_KEY', required: true }],
  models: [{ id: 'model-one', name: 'public-model', displayName: 'Public Model', apiKeyRef: { kind: 'none' },
    promptTemplate: 'authorized runtime {{secret.API_KEY}}' }],
  mcpServers: [{ name: 'public-server', transport: 'streamable',
    installOrigin: { sourceType: 'remote', name: 'Public Origin', url: 'https://fixture.invalid/mcp' },
    envDeclarations: [{ name: 'API_KEY', isSecret: true, secretRef: 'API_KEY' }],
    headerDeclarations: [{ name: 'Authorization', isSecret: true, secretRef: 'API_KEY' }] }],
  flows: [{ flow: { id: 'flow-one', name: 'Public Flow', nodes: [{ id: 'node-one', data: { label: 'Public Node',
    properties: { prompt: 'authorized runtime {{secret.API_KEY}}', parallelSubflowIds: ['flow-one'] } } }],
    edges: [{ id: 'edge-one', source: 'node-one', target: 'node-one', sourceHandle: 'output', targetHandle: 'input' }] },
  references: { flowIds: ['flow-one'], modelIds: ['model-one'], mcpServerNames: ['public-server'] } }],
  plannedExecutions: [{ id: 'plan-one', name: 'Public Plan', flowId: 'flow-one', enabled: false,
    prompt: 'authorized runtime {{secret.API_KEY}}', trigger: { type: 'manual' } }],
});

const fields = [
  'id', 'name', 'models.0.id', 'models.0.name', 'models.0.displayName',
  'mcpServers.0.name', 'mcpServers.0.installOrigin.name', 'mcpServers.0.envDeclarations.0.name',
  'mcpServers.0.headerDeclarations.0.name', 'flows.0.flow.id', 'flows.0.flow.name',
  'flows.0.references.flowIds.0', 'flows.0.references.modelIds.0', 'flows.0.references.mcpServerNames.0',
  'flows.0.flow.nodes.0.id', 'flows.0.flow.nodes.0.data.label',
  ...['flowId', 'subflowId', 'subFlowId', 'boundModel', 'modelId', 'model', 'boundServer',
    'mcpServer', 'serverName', 'server', 'modelName', 'parallelSubflowIds.0']
    .map(field => `flows.0.flow.nodes.0.data.properties.${field}`),
  ...['id', 'source', 'target', 'sourceHandle', 'targetHandle'].map(field => `flows.0.flow.edges.0.${field}`),
  'plannedExecutions.0.id', 'plannedExecutions.0.name', 'plannedExecutions.0.flowId',
];

test.each(fields)('rejects a declared secret placeholder in public field %s', field => {
  const input = manifest();
  const segments = field.split('.');
  let record: any = input;
  for (const segment of segments.slice(0, -1)) record = record[segment];
  record[segments.at(-1)!] = placeholder;
  const result = validatePackage(input);
  expect(result.success).toBe(false);
  expect(result.errors?.join(' ')).toContain(message);
});

test('public identities remain valid while declared runtime prompt placeholders are allowed', () => {
  const result = validatePackage(manifest());
  expect(result.success).toBe(true);
  expect(result.data?.flows[0].flow.nodes[0].data.properties.prompt).toContain('{{secret.API_KEY}}');
});
