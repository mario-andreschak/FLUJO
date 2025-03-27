import '@testing-library/jest-dom';

// Extend Jest matchers
expect.extend({});

// Global mocks
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn()
  })
})); 