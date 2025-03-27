import { jest } from '@jest/globals';

declare global {
  var fetch: jest.Mock;
}

export {}; 