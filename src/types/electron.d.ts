/**
 * Type definitions for Electron API
 */

interface ElectronAPI {
  /**
   * Gets the application path
   */
  getAppPath: () => Promise<string>;
  
  /**
   * Gets the application version
   */
  getAppVersion: () => Promise<string>;
  
  /**
   * Sets the network mode
   * @param enabled Whether to enable network mode
   */
  setNetworkMode: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  
  /**
   * The platform the app is running on
   */
  platform: string;
  
  /**
   * Whether the app is running in Electron
   */
  isElectron: boolean;
}

declare global {
  interface Window {
    /**
     * Electron API exposed through preload script
     */
    electron?: ElectronAPI;
  }
}

export {};
