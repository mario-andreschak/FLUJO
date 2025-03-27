/**
 * @jest-environment node
 */
import * as sharedExports from '../shared';

// Define interface for mocked exports
interface MockedSharedExports {
  mockCommonFunction: string;
  mockElectronFunction: string;
  mockResolveGlobalVars: string;
}

// Mock the imported modules
jest.mock('../shared/index', () => ({
  mockCommonFunction: 'common function',
  mockElectronFunction: 'electron function',
  mockResolveGlobalVars: 'resolve function'
}));

describe('Shared utilities exports', () => {
  test('re-exports all functions from shared/index', () => {
    // Use type assertion to access mocked properties
    const exports = sharedExports as unknown as MockedSharedExports;
    
    // Check that the shared exports include items from the mocked module
    expect(exports).toHaveProperty('mockCommonFunction');
    expect(exports).toHaveProperty('mockElectronFunction');
    expect(exports).toHaveProperty('mockResolveGlobalVars');

    // Verify the values to ensure they're coming from the mocked module
    expect(exports.mockCommonFunction).toBe('common function');
    expect(exports.mockElectronFunction).toBe('electron function');
    expect(exports.mockResolveGlobalVars).toBe('resolve function');
  });
}); 