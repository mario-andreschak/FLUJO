/**
 * @jest-environment node
 */
import * as sharedIndexExports from '../index';

// Define interface for mocked exports
interface MockedIndexExports {
  mockCommonFunction1: string;
  mockCommonFunction2: string;
  isElectron: () => boolean;
  isElectronMain: () => boolean;
  resolveEnvVar: string;
  resolveAllEnvVars: string;
}

// Mock the imported modules
jest.mock('../common', () => ({
  mockCommonFunction1: 'common function 1',
  mockCommonFunction2: 'common function 2'
}));

jest.mock('../isElectron', () => ({
  isElectron: () => false,
  isElectronMain: () => false
}));

jest.mock('../../../backend/utils/resolveGlobalVars', () => ({
  resolveEnvVar: 'resolve env var function',
  resolveAllEnvVars: 'resolve all env vars function'
}));

describe('Shared index exports', () => {
  test('exports client-safe utilities', () => {
    // Use type assertion to access mocked properties
    const exports = sharedIndexExports as unknown as MockedIndexExports;
    
    // Check common exports
    expect(exports).toHaveProperty('mockCommonFunction1');
    expect(exports).toHaveProperty('mockCommonFunction2');
    expect(exports.mockCommonFunction1).toBe('common function 1');
    expect(exports.mockCommonFunction2).toBe('common function 2');
    
    // Check isElectron exports
    expect(exports).toHaveProperty('isElectron');
    expect(exports).toHaveProperty('isElectronMain');
    expect(typeof exports.isElectron).toBe('function');
    expect(typeof exports.isElectronMain).toBe('function');
    expect(exports.isElectron()).toBe(false);
    expect(exports.isElectronMain()).toBe(false);
  });

  test('exports server-only utilities', () => {
    // Use type assertion to access mocked properties
    const exports = sharedIndexExports as unknown as MockedIndexExports;
    
    // Check resolveGlobalVars exports
    expect(exports).toHaveProperty('resolveEnvVar');
    expect(exports).toHaveProperty('resolveAllEnvVars');
    expect(exports.resolveEnvVar).toBe('resolve env var function');
    expect(exports.resolveAllEnvVars).toBe('resolve all env vars function');
  });
}); 