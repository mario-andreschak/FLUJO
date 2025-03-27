import { checkFileExists, readFile } from '../utils';

// Mock fetch
global.fetch = jest.fn();

describe('configparse utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkFileExists', () => {
    test('should return exists true when file exists', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'file content' })
      });

      const result = await checkFileExists('/repo', 'file.txt', true);
      
      expect(result).toEqual({
        exists: true,
        content: 'file content'
      });
      expect(fetch).toHaveBeenCalledWith('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'readFile',
          savePath: '/repo/file.txt'
        })
      });
    });

    test('should return exists false when file does not exist', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false
      });

      const result = await checkFileExists('/repo', 'file.txt');
      
      expect(result).toEqual({
        exists: false
      });
    });

    test('should handle empty files', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: '' })
      });

      const result = await checkFileExists('/repo', 'file.txt', true);
      
      expect(result).toEqual({
        exists: true,
        content: ''
      });
    });

    test('should handle errors', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const result = await checkFileExists('/repo', 'file.txt');
      
      expect(result).toEqual({
        exists: false
      });
    });
  });

  describe('readFile', () => {
    test('should return file content when file exists', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ content: 'file content' })
      });

      const result = await readFile('/repo', 'file.txt');
      
      expect(result).toBe('file content');
    });

    test('should return null when file does not exist', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false
      });

      const result = await readFile('/repo', 'file.txt');
      
      expect(result).toBeNull();
    });

    test('should handle errors', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const result = await readFile('/repo', 'file.txt');
      
      expect(result).toBeNull();
    });
  });
}); 