import { isElectron, getElectronAPI, getElectronPlatform, setElectronNetworkMode } from '../isElectron';

const createMockElectronAPI = (): ElectronAPI => ({
  isElectron: () => true,
  getAppVersion: jest.fn().mockResolvedValue('1.0.0'),
  setCwd: jest.fn().mockResolvedValue(undefined),
  getCwd: jest.fn().mockResolvedValue('/test'),
  setNetworkMode: jest.fn().mockResolvedValue({ success: true }),
  showOpenDialog: jest.fn().mockResolvedValue({ filePaths: [] }),
  showSaveDialog: jest.fn().mockResolvedValue({ filePath: '' }),
  platform: 'darwin',
  openExternal: jest.fn().mockResolvedValue(undefined),
  openPath: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(undefined)
});

describe('Electron Utilities', () => {
  const originalWindow = global.window;

  beforeEach(() => {
    // @ts-ignore
    delete global.window;
    // @ts-ignore
    global.window = {
      electron: createMockElectronAPI()
    };
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  describe('isElectron', () => {
    test('should return false when window is undefined', () => {
      // @ts-ignore
      delete global.window;
      expect(isElectron()).toBe(false);
    });

    test('should return false when electron is not in window', () => {
      // @ts-ignore
      global.window = {};
      expect(isElectron()).toBe(false);
    });

    test('should return true when electron is in window', () => {
      // @ts-ignore
      global.window.electron = createMockElectronAPI();
      expect(isElectron()).toBe(true);
    });
  });

  describe('getElectronAPI', () => {
    test('should return null when not in Electron', () => {
      // @ts-ignore
      global.window = {};
      expect(getElectronAPI()).toBeNull();
    });

    test('should return electron API when available', () => {
      const mockAPI = createMockElectronAPI();
      // @ts-ignore
      global.window.electron = mockAPI;
      expect(getElectronAPI()?.platform).toBe('darwin');
    });
  });

  describe('getElectronPlatform', () => {
    test('should return undefined when not in Electron', () => {
      // @ts-ignore
      global.window = {};
      expect(getElectronPlatform()).toBeUndefined();
    });

    test('should return platform when in Electron', () => {
      const mockAPI = createMockElectronAPI();
      // @ts-ignore
      global.window.electron = mockAPI;
      expect(getElectronPlatform()).toBe('darwin');
    });
  });

  describe('setElectronNetworkMode', () => {
    test('should resolve with error when not in Electron', async () => {
      // @ts-ignore
      global.window = {};
      const result = await setElectronNetworkMode(true);
      expect(result).toEqual({
        success: false,
        error: 'Not running in Electron'
      });
    });

    test('should call setNetworkMode when in Electron', async () => {
      const mockAPI = createMockElectronAPI();
      // @ts-ignore
      global.window.electron = mockAPI;
      
      await setElectronNetworkMode(true);
      expect(mockAPI.setNetworkMode).toHaveBeenCalledWith(true);
    });
  });
}); 