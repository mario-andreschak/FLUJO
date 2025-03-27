/**
 * @jest-environment node
 */
import * as mocks from '../mocks';
import * as helpers from '../helpers';

describe('helpers', () => {
  it('should re-export all functions from mocks', () => {
    // Get all function names from mocks
    const mockKeys = Object.keys(mocks);
    
    // Check that all mock functions are exported from helpers
    for (const key of mockKeys) {
      expect(helpers).toHaveProperty(key);
      // Use type assertion to safely compare the functions
      expect(helpers[key as keyof typeof helpers]).toBe(mocks[key as keyof typeof mocks]);
    }
  });
}); 