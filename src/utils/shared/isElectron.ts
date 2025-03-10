/**
 * Detects if the application is running in Electron
 * 
 * @returns {boolean} True if running in Electron, false otherwise
 */
export function isElectron(): boolean {
  // Check if the electron global is defined
  if (typeof window !== 'undefined' && typeof window.electron !== 'undefined') {
    return true;
  }
  
  // Check if the process object has electron-specific properties
  if (
    typeof window !== 'undefined' &&
    typeof window.process === 'object' &&
    (window.process as any)?.type === 'renderer'
  ) {
    return true;
  }
  
  // Check if the navigator userAgent contains electron
  if (
    typeof window !== 'undefined' &&
    typeof window.navigator === 'object' &&
    typeof window.navigator.userAgent === 'string' &&
    window.navigator.userAgent.indexOf('Electron') >= 0
  ) {
    return true;
  }
  
  return false;
}

/**
 * Gets the Electron API if available
 * 
 * @returns The Electron API or undefined if not running in Electron
 */
export function getElectronAPI(): any {
  if (typeof window !== 'undefined' && typeof window.electron !== 'undefined') {
    return window.electron;
  }
  
  return undefined;
}

/**
 * Gets the platform if running in Electron
 * 
 * @returns The platform (win32, darwin, linux) or undefined if not running in Electron
 */
export function getElectronPlatform(): string | undefined {
  const api = getElectronAPI();
  return api?.platform;
}

/**
 * Sets the network mode in Electron
 * 
 * @param enabled Whether to enable network mode
 * @returns Promise that resolves when the operation is complete
 */
export async function setElectronNetworkMode(enabled: boolean): Promise<any> {
  const api = getElectronAPI();
  if (api?.setNetworkMode) {
    return api.setNetworkMode(enabled);
  }
  
  return Promise.resolve({ success: false, error: 'Not running in Electron' });
}
