// Mock Next.js router
jest.mock('next/router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    query: {}
  })
}));

// Mock Next.js navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
    query: {}
  }),
  useSearchParams: () => ({
    get: jest.fn(),
    getAll: jest.fn(),
    has: jest.fn(),
    forEach: jest.fn(),
    entries: jest.fn(),
    keys: jest.fn(),
    values: jest.fn(),
    toString: jest.fn()
  })
}));

// Add path alias resolution for Jest's require/import
const path = require('path');
global.process.env.NODE_PATH = path.resolve(__dirname, 'src');

// Fix issue with StorageKey enum in mocks
jest.mock('@/shared/types/storage', () => ({
  StorageKey: {
    ENCRYPTION_KEY: 'encryption_key',
    MCP_SERVERS: 'mcp_servers',
    USER_MODELS: 'user_models',
    FLOWS: 'flows',
    // Add other keys as needed
  }
}));

// Create empty mocks for commonly used modules to ensure they exist
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn()
}), { virtual: true });

jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn()
  }))
}), { virtual: true });

// Set up common test environment values
global.ResizeObserver = jest.fn().mockImplementation(() => ({
  observe: jest.fn(),
  unobserve: jest.fn(),
  disconnect: jest.fn(),
}));

// Silence console errors during tests
console.error = jest.fn(); 