import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { callTool } from '@/backend/services/mcp/tools';
import { flattenCustomHeaders, resolveConfigHeaders, resolveStdioLaunch } from '@/backend/services/mcp/connection';
import type { MCPStdioConfig, MCPStreamableConfig } from '@/shared/types/mcp';

jest.mock('@/backend/utils/resolveGlobalVars', () => ({ resolveGlobalVars: async (value: unknown) => value,
  resolveAndDecryptApiKey: async (value: unknown) => value }));

const common = { name: 'data-map-fixture', env: {}, rootPath: '.', disabled: false, _buildCommand: '', _installCommand: '' };
const names = ['__proto__', 'constructor', 'prototype', 'toString'];
const parameterData = () => Object.fromEntries(names.map(name => [name, { fixture: name }]));
const strings = () => Object.fromEntries(names.map(name => [name, `fixture-${name}`]));

test('own prototype-like tool parameters survive normalization and JSON serialization without changing prototypes', async () => {
  const transmitted = jest.fn(async (_params: { arguments: Record<string, unknown> }) => ({ content: [] }));
  const result = await callTool({ callTool: transmitted } as unknown as Client, 'ordinary-fixture', 'demo', parameterData());
  expect(result.success).toBe(true);
  const args = transmitted.mock.calls[0][0].arguments;
  expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  expect(JSON.parse(JSON.stringify(args))).toEqual(parameterData());
  expect(Object.getPrototypeOf(args)).not.toHaveProperty('fixture');
  expect(Object.prototype).not.toHaveProperty('fixture');
});

test('inherited tool parameters do not cross normalization while own null/default values retain existing behavior', async () => {
  const args = Object.create({ inheritedArgument: 'do-not-send' });
  Object.assign(args, { itemCount: null, isEnabled: undefined, records: null, plain: undefined });
  const transmitted = jest.fn(async (_params: { arguments: Record<string, unknown> }) => ({ content: [] }));
  expect((await callTool({ callTool: transmitted } as unknown as Client, 'ordinary-fixture', 'demo', args)).success).toBe(true);
  expect(transmitted.mock.calls[0][0].arguments).toEqual({ itemCount: 0, isEnabled: false, records: [], plain: '' });
});

test('resolved connection env and headers preserve own special names as data', async () => {
  const data = strings();
  const config: MCPStreamableConfig = { ...common, transport: 'streamable', serverUrl: 'https://mcp.example.com/mcp',
    env: data, headers: data };
  const result = await resolveConfigHeaders(config) as MCPStreamableConfig;
  expect(JSON.parse(JSON.stringify(result.env))).toEqual(data);
  expect(JSON.parse(JSON.stringify(result.headers))).toEqual(data);
  expect(Object.prototype).not.toHaveProperty('fixture');
});

test('header flattening does not mutate prototypes or lose a special-name header', () => {
  const headers = Object.fromEntries(names.map(name => [name, { value: `fixture-${name}`, metadata: { isSecret: false } }]));
  expect(JSON.parse(JSON.stringify(flattenCustomHeaders(headers)))).toEqual(strings());
});

test('normal stdio launch env keeps special-name values without inheriting unknown fields', () => {
  const env = Object.create({ inheritedVariable: 'do-not-send' }, Object.getOwnPropertyDescriptors(strings()));
  const config: MCPStdioConfig = { ...common, transport: 'stdio', command: 'fixture-command', args: [], env };
  const launch = resolveStdioLaunch(config);
  for (const name of names) expect(Object.prototype.hasOwnProperty.call(launch.env, name)).toBe(true);
  expect(JSON.parse(JSON.stringify(launch.env))).toMatchObject(strings());
  expect(launch.env).not.toHaveProperty('inheritedVariable');
  expect(Object.prototype).not.toHaveProperty('fixture');
});
