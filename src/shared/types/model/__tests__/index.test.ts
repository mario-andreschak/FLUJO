/**
 * @jest-environment node
 */
import * as modelIndexExports from '../index';

// Mock the imported modules
jest.mock('../model', () => ({
  mockModelType: 'model type'
}));

jest.mock('../response', () => ({
  mockResponseType: 'response type'
}));

jest.mock('../provider', () => ({
  mockProviderType: 'provider type'
}));

// Define interface for mocked exports
interface MockedModelExports {
  mockModelType: string;
  mockResponseType: string;
  mockProviderType: string;
}

describe('Model types index exports', () => {
  test('exports all required model type modules', () => {
    // Use type assertion to access mocked properties
    const exports = modelIndexExports as unknown as MockedModelExports;
    
    // Check that the exports include items from each module
    expect(exports).toHaveProperty('mockModelType');
    expect(exports).toHaveProperty('mockResponseType');
    expect(exports).toHaveProperty('mockProviderType');

    // Verify the values to ensure they're coming from the mocked modules
    expect(exports.mockModelType).toBe('model type');
    expect(exports.mockResponseType).toBe('response type');
    expect(exports.mockProviderType).toBe('provider type');
  });
}); 