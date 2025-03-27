/**
 * @jest-environment node
 */
import * as mcpIndexExports from '../index';

// Mock the imported modules
jest.mock('../types', () => ({
  mockType: 'type value'
}));

jest.mock('../processPathLikeArgument', () => ({
  processPathLikeArgument: jest.fn()
}));

jest.mock('../parseServerConfig', () => ({
  parseServerConfig: jest.fn()
}));

jest.mock('../parseServerConfigFromClipboard', () => ({
  parseServerConfigFromClipboard: jest.fn()
}));

jest.mock('../configparse', () => ({
  parseRepositoryConfig: jest.fn()
}));

// Define interface for mocked exports
interface MockedMcpExports {
  mockType: string;
  processPathLikeArgument: jest.Mock;
  parseServerConfig: jest.Mock;
  parseServerConfigFromClipboard: jest.Mock;
  parseRepositoryConfig: jest.Mock;
}

describe('MCP index exports', () => {
  test('exports all required MCP modules', () => {
    // Use type assertion to access mocked properties
    const exports = mcpIndexExports as unknown as MockedMcpExports;
    
    // Check that the exports include items from each module
    expect(exports).toHaveProperty('mockType');
    expect(exports).toHaveProperty('processPathLikeArgument');
    expect(exports).toHaveProperty('parseServerConfig');
    expect(exports).toHaveProperty('parseServerConfigFromClipboard');
    expect(exports).toHaveProperty('parseRepositoryConfig');

    // Verify the values to ensure they're coming from the mocked modules
    expect(exports.mockType).toBe('type value');
    expect(typeof exports.processPathLikeArgument).toBe('function');
    expect(typeof exports.parseServerConfig).toBe('function');
    expect(typeof exports.parseServerConfigFromClipboard).toBe('function');
    expect(typeof exports.parseRepositoryConfig).toBe('function');
  });
}); 