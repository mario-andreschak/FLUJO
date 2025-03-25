/**
 * Detects if the application is running in Electron
 *
 * @returns {boolean} True if running in Electron, false otherwise
 */
export function isElectron(): boolean {
  // Check if window exists (for SSR)
  if (typeof window === "undefined") {
    return false;
  }

  // Check if electron property exists
  if ("electron" in window) {
    return true;
  }

  return false;
}

/**
 * Gets the Electron API if available
 *
 * @returns The Electron API or undefined if not running in Electron
 */
export function getElectronAPI(): Window["electron"] | null {
  if (isElectron()) {
    return window.electron;
  }
  return null;
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

  return Promise.resolve({ success: false, error: "Not running in Electron" });
}
