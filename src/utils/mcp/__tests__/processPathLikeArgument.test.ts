import { processPathLikeArgument } from '../processPathLikeArgument';

// Mock logger
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('processPathLikeArgument', () => {
  test('should return original arg if not path-like', () => {
    expect(processPathLikeArgument('simple-arg')).toBe('simple-arg');
    expect(processPathLikeArgument('')).toBe('');
    expect(processPathLikeArgument(undefined as unknown as string)).toBe(undefined);
  });

  test('should strip common path patterns', () => {
    const patterns = [
      ['/path/to/file.txt', 'file.txt'],
      ['PATH_TO/config.json', 'config.json'],
      ['path/to/script.sh', 'script.sh'],
      ['PATH/TO/data.csv', 'data.csv'],
      ['/PATH/TO/model.bin', 'model.bin'],
      ['/PATH_TO/settings.yml', 'settings.yml'],
      ['path_to/input.txt', 'input.txt'],
    ];

    patterns.forEach(([input, expected]) => {
      expect(processPathLikeArgument(input)).toBe(expected);
    });
  });

  test('should handle server name in path', () => {
    const serverName = 'my-server';
    const testCases = [
      ['my-server/config.json', 'config.json'],
      ['/my-server/data/file.txt', 'data/file.txt'],
      ['path/my-server/script.sh', 'path/script.sh'],
      ['other-server/file.txt', 'other-server/file.txt'], // shouldn't match
    ];

    testCases.forEach(([input, expected]) => {
      expect(processPathLikeArgument(input, serverName)).toBe(expected);
    });
  });

  test('should handle leading slashes', () => {
    expect(processPathLikeArgument('/config.json')).toBe('config.json');
    expect(processPathLikeArgument('\\settings.yml')).toBe('settings.yml');
  });

  test('should replace empty result with "."', () => {
    expect(processPathLikeArgument('/path/to/')).toBe('.');
    expect(processPathLikeArgument('/PATH_TO/')).toBe('.');
  });

  test('should handle multiple patterns in the same path', () => {
    expect(processPathLikeArgument('/path/to/PATH_TO/file.txt')).toBe('PATH_TO/file.txt');
    expect(processPathLikeArgument('path/to/path_to/config.json')).toBe('path_to/config.json');
  });
}); 