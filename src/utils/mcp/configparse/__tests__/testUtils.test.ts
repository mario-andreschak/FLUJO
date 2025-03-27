import { jest } from '@jest/globals';
import { mockFileSystem, mockLogger } from '../mocks';

describe('configparse test utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('mockFileSystem', () => {
    it('should handle file existence checks', async () => {
      const fs = mockFileSystem({
        'test.txt': 'content'
      });

      const result1 = await fs.checkFileExists('repo', 'test.txt', true);
      expect(result1).toEqual({ exists: true, content: 'content' });

      const result2 = await fs.checkFileExists('repo', 'nonexistent.txt');
      expect(result2).toEqual({ exists: false });
    });

    it('should handle file reading', async () => {
      const fs = mockFileSystem({
        'test.txt': 'content'
      });

      const content = await fs.readFile('repo', 'test.txt');
      expect(content).toBe('content');

      const nonexistent = await fs.readFile('repo', 'nonexistent.txt');
      expect(nonexistent).toBeNull();
    });
  });

  describe('mockLogger', () => {
    it('should create a mock logger with all log levels', () => {
      const testMessage = 'test message';
      
      mockLogger.debug(testMessage);
      mockLogger.info(testMessage);
      mockLogger.warn(testMessage);
      mockLogger.error(testMessage);

      expect(mockLogger.debug).toHaveBeenCalledWith(testMessage);
      expect(mockLogger.info).toHaveBeenCalledWith(testMessage);
      expect(mockLogger.warn).toHaveBeenCalledWith(testMessage);
      expect(mockLogger.error).toHaveBeenCalledWith(testMessage);
    });
  });
}); 