import { parseServerConfigFromClipboard } from '../parseServerConfigFromClipboard';
import { parseServerConfig } from '../parseServerConfig';

// Mock dependencies
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock('../parseServerConfig');

describe('parseServerConfigFromClipboard', () => {
  const mockClipboardText = 'test clipboard content';
  const mockParseResult = {
    config: { name: 'test-server' },
    message: { type: 'success', text: 'Success' }
  };

  beforeEach(() => {
    // Mock clipboard API
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        readText: jest.fn().mockResolvedValue(mockClipboardText)
      },
      writable: true
    });

    // Mock parseServerConfig
    (parseServerConfig as jest.Mock).mockReturnValue(mockParseResult);
  });

  test('should read clipboard and parse content', async () => {
    const result = await parseServerConfigFromClipboard();

    expect(navigator.clipboard.readText).toHaveBeenCalled();
    expect(parseServerConfig).toHaveBeenCalledWith(mockClipboardText, true, undefined);
    expect(result).toEqual(mockParseResult);
  });

  test('should pass parseEnvVars parameter', async () => {
    await parseServerConfigFromClipboard(false);
    expect(parseServerConfig).toHaveBeenCalledWith(mockClipboardText, false, undefined);
  });

  test('should pass serverName parameter', async () => {
    await parseServerConfigFromClipboard(true, 'test-server');
    expect(parseServerConfig).toHaveBeenCalledWith(mockClipboardText, true, 'test-server');
  });

  test('should handle clipboard read errors', async () => {
    const mockError = new Error('Clipboard error');
    (navigator.clipboard.readText as jest.Mock).mockRejectedValue(mockError);

    const result = await parseServerConfigFromClipboard();

    expect(result).toEqual({
      config: {},
      message: {
        type: 'error',
        text: 'Failed to read clipboard content.'
      }
    });
  });
}); 