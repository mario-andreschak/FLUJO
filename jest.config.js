/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      jsx: 'react-jsx'
    }]
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  // Add these settings to better handle TypeScript
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  
  // Add moduleDirectories to help with module resolution
  moduleDirectories: ['node_modules', 'src'],
  
  // Specifically focus on backend tests by excluding frontend files
  testPathIgnorePatterns: [
    '/node_modules/', 
    '/dist/', 
    '/src/frontend/',
    '/src/app/'
  ],
  
  // Add this to clear mock calls between tests
  clearMocks: true,
  resetMocks: false,
  restoreMocks: false,
  
  // Memory optimization settings
  maxWorkers: '50%', // Reduce parallel test execution to save memory
  
  // Coverage optimization
  collectCoverageFrom: [
    'src/backend/**/*.ts',
    'src/utils/**/*.ts',
    'src/shared/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/node_modules/**',
    '!src/frontend/**/*.tsx', 
    '!src/app/**/*.tsx',
  ],
  coverageReporters: ['text', 'lcov', 'json-summary'],
  coveragePathIgnorePatterns: [
    "/node_modules/",
    "/backend/execution/flow/",  // Ignore flow directory
    "/utils/storage/",           // Ignore storage directory
    "/shared/types/storage/",    // Ignore storage types
    "/shared/types/flow/",       // Ignore flow types
    "/utils/logger/index.ts"     // Ignore simple re-export module
  ],
  // Optional: If you want to keep the coverage thresholds but ignore these directories
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80
    }
  }
};

module.exports = config; 