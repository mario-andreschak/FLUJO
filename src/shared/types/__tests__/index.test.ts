/**
 * @jest-environment node
 */
import * as indexExports from '../index';

// Define a type that includes our mock properties
interface MockedExports {
  mockMcpExport: string;
  mockStorageExport: string;
  mockFlowExport: string;
  mockModelExport: string;
}

// Mock the imported modules
jest.mock('../mcp/mcp', () => ({
  mockMcpExport: 'mcp value'
}));

jest.mock('../storage', () => ({
  mockStorageExport: 'storage value'
}));

jest.mock('../flow/flow', () => ({
  mockFlowExport: 'flow value'
}));

jest.mock('../model/model', () => ({
  mockModelExport: 'model value'
}));

describe('Index exports', () => {
  test('exports all required modules', () => {
    // Use type assertion to allow accessing the mocked properties
    const exports = indexExports as unknown as MockedExports;
    
    // Check that the index exports include items from each module
    expect(exports).toHaveProperty('mockMcpExport');
    expect(exports).toHaveProperty('mockStorageExport');
    expect(exports).toHaveProperty('mockFlowExport');
    expect(exports).toHaveProperty('mockModelExport');

    // Verify the values to ensure they're coming from the mocked modules
    expect(exports.mockMcpExport).toBe('mcp value');
    expect(exports.mockStorageExport).toBe('storage value');
    expect(exports.mockFlowExport).toBe('flow value');
    expect(exports.mockModelExport).toBe('model value');
  });
}); 