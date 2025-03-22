export interface ThemeContextType {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

export interface StorageContextType {
  setKey: (key: string) => Promise<void>;
  changeKey: (oldKey: string, newKey: string) => Promise<boolean>;
  verifyKey: (key: string) => Promise<boolean>;
  isEncryptionInitialized: () => Promise<boolean>;
  isUserEncryptionEnabled: () => Promise<boolean>;
  isLoading: boolean;
}
