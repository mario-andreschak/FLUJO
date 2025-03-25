// Global type definitions for the application

// Add TypeScript declarations for Node.js globals
declare namespace NodeJS {
  interface Global {
    gc?: () => void;
  }
}

// Electron API interface definition
interface ElectronAPI {
  isElectron: () => boolean;
  getAppVersion: () => string;
  setCwd: (path: string) => void;
  getCwd: () => Promise<string>;
  openExternal: (url: string) => void;
  openPath: (path: string) => void;
  showOpenDialog: (
    options: any
  ) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (
    options: any
  ) => Promise<{ canceled: boolean; filePath?: string }>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;

  // Additional properties
  platform?: string;
  setNetworkMode?: (enabled: boolean) => Promise<any>;
  getAppPath?: () => Promise<string>;
}

// Extend the Window interface
interface Window {
  electron: ElectronAPI;
  gc?: () => void; // Ensure TypeScript recognizes the gc function on the global object
}
