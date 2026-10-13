import { McpRuntimeAuthorityRetirementError } from '@/backend/services/mcp/connection';

test('genuine retirement errors retain their classification across independent module graphs', () => {
  let other!: typeof import('@/backend/services/mcp/connection');
  jest.isolateModules(() => { other = jest.requireActual('@/backend/services/mcp/connection'); });
  expect(other.McpRuntimeAuthorityRetirementError).not.toBe(McpRuntimeAuthorityRetirementError);
  const primary = new Error('equipment retirement failure');
  const error = new McpRuntimeAuthorityRetirementError([primary], 'MCP runtime authority retirement failed.', { cause: primary });
  expect(error).toBeInstanceOf(other.McpRuntimeAuthorityRetirementError);
  expect(error.cause).toBe(primary);
  expect(error.errors).toEqual([primary]);
  const reverse = new other.McpRuntimeAuthorityRetirementError([primary]);
  expect(reverse).toBeInstanceOf(McpRuntimeAuthorityRetirementError);
});

test('public retirement error lookalikes and prototype copies are never genuine errors', () => {
  const forged = Object.assign(new AggregateError([], 'MCP runtime authority retirement failed.'), {
    name: 'McpRuntimeAuthorityRetirementError', code: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN',
  });
  expect(forged).not.toBeInstanceOf(McpRuntimeAuthorityRetirementError);
  expect(Object.create(McpRuntimeAuthorityRetirementError.prototype)).not.toBeInstanceOf(McpRuntimeAuthorityRetirementError);
  expect({ ...new McpRuntimeAuthorityRetirementError([]) }).not.toBeInstanceOf(McpRuntimeAuthorityRetirementError);
});
