"use client";

import React, { createContext, useContext, useCallback, useState, useEffect } from 'react';
import {
  saveItem,
  StorageKey,
} from '@/utils/storage';
import { isSecretEnvVar } from '@/utils/shared/common';
import { createLogger } from '@/utils/logger';
import { Settings } from '@/shared/types/storage/storage';
import { ENCRYPTION_UNLOCKED_EVENT } from '@/frontend/utils/encryptionLock';

// Create a logger instance for this file
const log = createLogger('frontend/contexts/StorageContext');

interface StorageContextType {
  setKey: (key: string) => Promise<void>;
  changeKey: (oldKey: string, newKey: string) => Promise<boolean>;
  verifyKey: (key: string) => Promise<boolean>;
  isEncryptionInitialized: () => Promise<boolean>;
  globalEnvVars: Record<string, { value: string, metadata: { isSecret: boolean } }>;
  setGlobalEnvVars: (vars: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => Promise<void>;
  deleteGlobalEnvVar: (key: string) => Promise<void>;
  encryptValue: (value: string, password?: string) => Promise<string | null>;
  decryptValue: (encryptedValue: string, password?: string) => Promise<string | null>;
  isUserEncryptionEnabled: () => Promise<boolean>;
  isLoading: boolean; // Loading state
  settings: Settings; // Application settings
  /**
   * True only once settings were genuinely read from persistent storage. While
   * USER encryption is locked the settings route returns 423 and we fall back
   * to defaults; in that case this stays false so consumers (e.g. the guided
   * tour) don't act on fallback data. It flips to true after a successful
   * (post-unlock) read.
   */
  settingsHydrated: boolean;
  updateSettings: (newSettings: Settings) => Promise<void>; // Update settings
}

const StorageContext = createContext<StorageContextType>({
  setKey: async () => {},
  changeKey: async () => false,
  verifyKey: async () => false,
  isEncryptionInitialized: async () => false,
  globalEnvVars: {} as Record<string, { value: string, metadata: { isSecret: boolean } }>,
  setGlobalEnvVars: async () => {},
  deleteGlobalEnvVar: async () => {},
  encryptValue: async () => null,
  decryptValue: async () => null,
  isUserEncryptionEnabled: async () => false,
  isLoading: true,
  settings: {
    speech: {
      enabled: true
    },
    update: {
      checkOnStartup: false
    }
  },
  settingsHydrated: false,
  updateSettings: async () => {},
});

export const useStorage = () => useContext(StorageContext);

export const StorageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Track hydration status
  const [isHydrated, setIsHydrated] = useState(false);
  // Track whether settings were genuinely read from storage (vs. the locked
  // 423 fallback to defaults). See StorageContextType.settingsHydrated.
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [globalEnvVars, setGlobalEnvVarsState] = useState<Record<string, { value: string, metadata: { isSecret: boolean } }>>({});
  const [settings, setSettings] = useState<Settings>({
    speech: {
      enabled: true
    },
    update: {
      checkOnStartup: false
    }
  });

  // Define encryption-related functions first
  const isEncryptionInitialized = useCallback(async (): Promise<boolean> => {
    log.debug('isEncryptionInitialized: Entering method');
    try {
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'check_initialized'
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to check encryption status');
      }

      const data = await response.json();
      return data.initialized === true;
    } catch (error) {
      log.warn('isEncryptionInitialized: Failed to check encryption status:', error);
      return false;
    }
  }, []);

  const setKey = useCallback(async (key: string) => {
    log.debug('setKey: Entering method');
    try {
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'initialize',
          password: key
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to set encryption key');
      }
    } catch (error) {
      log.warn('setKey: Failed to set encryption key:', error);
    }
  }, []);

  const changeKey = useCallback(async (oldKey: string, newKey: string): Promise<boolean> => {
    log.debug('changeKey: Entering method');
    try {
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'change_password',
          oldPassword: oldKey,
          newPassword: newKey
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to change encryption key');
      }

      const data = await response.json();
      
      // If successful and we have a session token, update it
      if (data.success && typeof window !== 'undefined') {
        // Get the current token
        const currentToken = sessionStorage.getItem('encryption_token');
        if (currentToken) {
          // Authenticate with the new password to get a new token
          const authResponse = await fetch('/api/encryption/secure', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'authenticate',
              password: newKey
            }),
          });
          
          if (authResponse.ok) {
            const authData = await authResponse.json();
            if (authData.success && authData.token) {
              // Update the session token
              sessionStorage.setItem('encryption_token', authData.token);
              sessionStorage.setItem('encryption_authenticated', 'true');
              // Remove the old password if it exists
              sessionStorage.removeItem('encryption_key');
            }
          }
        }
      }
      
      return data.success === true;
    } catch (error) {
      log.warn('changeKey: Failed to change encryption key:', error);
      return false;
    }
  }, []);

  const verifyKey = useCallback(async (key: string): Promise<boolean> => {
    log.debug('verifyKey: Entering method');
    try {
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify_password',
          password: key
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to verify encryption key');
      }

      const data = await response.json();
      
      // If the password is valid and we have a token, store it in session storage
      if (data.valid && data.token && typeof window !== 'undefined') {
        sessionStorage.setItem('encryption_token', data.token);
        sessionStorage.setItem('encryption_authenticated', 'true');
        // Remove the old password if it exists
        sessionStorage.removeItem('encryption_key');
      }
      
      return data.valid === true;
    } catch (error) {
      log.warn('verifyKey: Failed to verify encryption key:', error);
      return false;
    }
  }, []);

  // Load application settings (speech + update + onboarding) directly so we can
  // tell a genuine persisted read from the locked (423) fallback. On success we
  // mark settingsHydrated true; on a non-ok response (e.g. 423 while encryption
  // is locked) we keep the defaults and leave settingsHydrated false so the
  // guided tour won't auto-start on fallback data.
  const loadSettings = useCallback(async () => {
    const defaultSettings: Settings = {
      speech: { enabled: true },
      update: { checkOnStartup: false }
    };
    try {
      const response = await fetch(
        `/api/storage?key=${encodeURIComponent(StorageKey.SPEECH_SETTINGS)}&defaultValue=${encodeURIComponent(JSON.stringify(defaultSettings))}`
      );
      if (!response.ok) {
        log.debug('loadSettings: settings read not ok, keeping defaults', { status: response.status });
        return;
      }
      const data = await response.json();
      log.debug('Loaded settings from storage', { settings: data.value });
      setSettings(data.value ?? defaultSettings);
      setSettingsHydrated(true);
    } catch (error) {
      log.warn('loadSettings: failed to load settings:', error);
    }
  }, []);

  // Re-read settings after the user unlocks USER-mode encryption: the initial
  // (locked) boot fell back to defaults with settingsHydrated=false, so this
  // pulls in the real persisted values (incl. onboarding.completed) once the
  // gated storage route succeeds.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onUnlocked = () => {
      log.info('Encryption unlocked signal received; reloading settings');
      loadSettings();
    };
    window.addEventListener(ENCRYPTION_UNLOCKED_EVENT, onUnlocked);
    return () => window.removeEventListener(ENCRYPTION_UNLOCKED_EVENT, onUnlocked);
  }, [loadSettings]);

  // Load initial models and global env vars after hydration
  useEffect(() => {
    const loadData = async () => {
      log.debug('loadData: Entering method');
      try {
        // Call the initialization API to verify storage
        log.info('Calling initialization API to verify storage');
        const initResponse = await fetch('/api/init');
        if (!initResponse.ok) {
          const errorData = await initResponse.json();
          log.warn('Storage initialization warning:', errorData.error);
        } else {
          log.info('Storage initialization completed successfully');
        }
        
        // First ensure encryption is initialized
        const isEncryptionInit = await isEncryptionInitialized();
        if (!isEncryptionInit) {
          // Initialize default encryption
          await fetch('/api/encryption/secure', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              action: 'initialize_default'
            }),
          });
        }
        
        // Load environment variables from the server-side API
        // We don't include secrets in the UI for security
        const response = await fetch('/api/env?includeSecrets=false');
        if (response.ok) {
          const data = await response.json();
          log.debug('Loaded environment variables', { count: Object.keys(data.variables || {}).length });
          setGlobalEnvVarsState(data.variables || {});
        } else {
          log.error('loadData: Failed to load environment variables');
          setGlobalEnvVarsState({});
        }
        
        // Load application settings (speech + update). Uses a dedicated helper
        // that distinguishes a real read from the locked 423 fallback.
        await loadSettings();
        
        setIsHydrated(true);
      } catch (error) {
        log.error('loadData: Error loading data:', error);
        setIsHydrated(true); // Still set hydrated to true to avoid blocking the UI
      }
    };
    
    loadData();
  }, [isEncryptionInitialized, loadSettings]);

  const encryptValue = useCallback(async (value: string, password?: string): Promise<string | null> => {
    log.debug('encryptValue: Entering method');
    try {
      // Check if we have a token in session storage (from authentication)
      const sessionToken = typeof window !== 'undefined' ? sessionStorage.getItem('encryption_token') : null;
      // Check if we have a password in session storage (legacy support)
      const sessionPassword = typeof window !== 'undefined' ? sessionStorage.getItem('encryption_key') : null;
      
      // Prepare the request body
      const requestBody: any = {
        action: 'encrypt',
        data: value
      };
      
      // Use token first, then provided password, then session password
      if (sessionToken) {
        requestBody.token = sessionToken;
      } else if (password) {
        requestBody.password = password;
      } else if (sessionPassword) {
        requestBody.password = sessionPassword;
      }
      
      // Use the secure server-side API for encryption
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error('Failed to encrypt value');
      }

      const data = await response.json();
      return data.result;
    } catch (error) {
      log.warn('encryptValue: Failed to encrypt value:', error);
      return null;
    }
  }, []);

  // This method is deprecated and should not be used
  // Decryption should only happen on the backend
  const decryptValue = useCallback(async (encryptedValue: string, password?: string): Promise<string | null> => {
    log.debug('decryptValue: Entering method - THIS METHOD IS DEPRECATED');
    log.warn('decryptValue: Frontend decryption is deprecated for security reasons');
    
    // For backward compatibility, return null instead of throwing an error
    return null;
  }, []);

  const isUserEncryptionEnabled = useCallback(async (): Promise<boolean> => {
    log.debug('isUserEncryptionEnabled: Entering method');
    try {
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'check_user_encryption'
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to check user encryption status');
      }

      const data = await response.json();
      return data.userEncryption === true;
    } catch (error) {
      log.warn('isUserEncryptionEnabled: Failed to check user encryption status:', error);
      return false;
    }
  }, []);

  const setGlobalEnvVars = useCallback(async (vars: Record<string, { value: string, metadata: { isSecret: boolean } } | string>) => {
    log.debug('setGlobalEnvVars: Entering method');
    try {
      // First ensure encryption is initialized
      const isEncryptionInit = await isEncryptionInitialized();
      if (!isEncryptionInit) {
        // Initialize default encryption
        await fetch('/api/encryption/secure', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'initialize_default'
          }),
        });
      }
      
      // Use the server-side API to securely store environment variables
      const response = await fetch('/api/env', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'setAll',
          variables: vars
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        log.error('setGlobalEnvVars: Failed to set environment variables:', errorData.error);
        return;
      }

      // Update the local state with the unencrypted values for UI display
      // For secret values, we'll display asterisks
      const displayVars: Record<string, { value: string, metadata: { isSecret: boolean } }> = {};
      for (const [key, varData] of Object.entries(vars)) {
        // Handle both string values (old format) and object values (new format)
        const value = typeof varData === 'object' && varData !== null && 'value' in varData
          ? varData.value
          : varData as string;
          
        const metadata = typeof varData === 'object' && varData !== null && 'metadata' in varData
          ? varData.metadata
          : { isSecret: isSecretEnvVar(key) };
        
        if (metadata.isSecret) {
          displayVars[key] = { value: '********', metadata };
        } else {
          displayVars[key] = { value, metadata };
        }
      }
      
      setGlobalEnvVarsState(displayVars);
    } catch (error) {
      log.error('setGlobalEnvVars: Error setting environment variables:', error);
    }
  }, [isEncryptionInitialized]);

  const deleteGlobalEnvVar = useCallback(async (key: string) => {
    log.debug(`deleteGlobalEnvVar: Deleting environment variable: ${key}`);
    try {
      // Use the server-side API to delete the environment variable
      const response = await fetch('/api/env', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'delete',
          key
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        log.error('deleteGlobalEnvVar: Failed to delete environment variable:', errorData.error);
        return;
      }

      // Update the local state by removing the variable
      setGlobalEnvVarsState(prev => {
        const updated = { ...prev };
        delete updated[key];
        return updated;
      });
    } catch (error) {
      log.error('deleteGlobalEnvVar: Error deleting environment variable:', error);
    }
  }, []);
  
  // Update application settings
  const updateSettings = useCallback(async (newSettings: Settings) => {
    log.debug('updateSettings: Updating settings', { newSettings });
    try {
      await saveItem(StorageKey.SPEECH_SETTINGS, newSettings);
      setSettings(newSettings);
    } catch (error) {
      log.error('updateSettings: Error updating settings:', error);
    }
  }, []);

  return (
    <StorageContext.Provider
      value={{
        setKey,
        changeKey,
        verifyKey,
        isEncryptionInitialized,
        globalEnvVars,
        setGlobalEnvVars,
        deleteGlobalEnvVar,
        encryptValue,
        decryptValue,
        isUserEncryptionEnabled,
        isLoading: !isHydrated,
        settings,
        settingsHydrated,
        updateSettings,
      }}
    >
      {children}
    </StorageContext.Provider>
  );
};

export default StorageContext;
