// Mock FEATURES first, before any imports
jest.mock('@/config/features', () => ({
  FEATURES: {
    LOG_LEVEL: -1 // Set to VERBOSE (-1) directly instead of using LOG_LEVEL constant
  }
}));

import { createLogger, normalizeFilePath, LOG_LEVEL } from '../logger';

describe('Logger', () => {
  let consoleSpies: { [key: string]: jest.SpyInstance };

  beforeEach(() => {
    // Setup console spies
    consoleSpies = {
      debug: jest.spyOn(console, 'debug').mockImplementation(),
      info: jest.spyOn(console, 'info').mockImplementation(),
      warn: jest.spyOn(console, 'warn').mockImplementation(),
      error: jest.spyOn(console, 'error').mockImplementation(),
      log: jest.spyOn(console, 'log').mockImplementation(),
    };
  });

  afterEach(() => {
    // Restore console spies
    Object.values(consoleSpies).forEach(spy => spy.mockRestore());
  });

  describe('normalizeFilePath', () => {
    test('should remove src/ prefix', () => {
      expect(normalizeFilePath('src/utils/logger')).toBe('utils/logger');
    });

    test('should remove leading slash', () => {
      expect(normalizeFilePath('/utils/logger')).toBe('utils/logger');
    });

    test('should handle paths without src/ or leading slash', () => {
      expect(normalizeFilePath('utils/logger')).toBe('utils/logger');
    });
  });

  describe('createLogger', () => {
    const testPath = 'utils/test';
    let logger: ReturnType<typeof createLogger>;

    beforeEach(() => {
      logger = createLogger(testPath);
    });

    test('should create logger with all methods', () => {
      expect(logger.verbose).toBeDefined();
      expect(logger.debug).toBeDefined();
      expect(logger.info).toBeDefined();
      expect(logger.warn).toBeDefined();
      expect(logger.error).toBeDefined();
    });

    test('should log messages with correct level', () => {
      logger.error('test error');
      expect(consoleSpies.error).toHaveBeenCalledWith(
        expect.stringContaining('[utils/test] test error')
      );
    });

    test('should handle objects in data parameter', () => {
      const testData = { key: 'value' };
      logger.info('test info', testData);
      expect(consoleSpies.info).toHaveBeenCalledWith(
        expect.stringMatching(/\[.*\] \[utils\/test\] test info:\s*{\s*"key": "value"\s*}/)
      );
    });

    test('should handle non-stringifiable objects', () => {
      const circular: any = {};
      circular.self = circular;
      
      logger.debug('test debug', circular);
      expect(consoleSpies.debug).toHaveBeenCalledWith(
        expect.stringContaining('[Object cannot be stringified]')
      );
    });

    test('should respect log level thresholds', () => {
      const highLevelLogger = createLogger(testPath, LOG_LEVEL.ERROR);
      
      highLevelLogger.debug('debug message');
      highLevelLogger.info('info message');
      highLevelLogger.warn('warn message');
      highLevelLogger.error('error message');

      expect(consoleSpies.debug).not.toHaveBeenCalled();
      expect(consoleSpies.info).not.toHaveBeenCalled();
      expect(consoleSpies.warn).not.toHaveBeenCalled();
      expect(consoleSpies.error).toHaveBeenCalledWith(
        expect.stringContaining('error message')
      );
    });
  });
}); 