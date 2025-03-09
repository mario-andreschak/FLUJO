"use client";

import React, { createContext, useContext, useCallback, useState, useEffect } from 'react';
import {
  saveItem,
  loadItem,
  StorageKey,
} from '@/utils/storage';
import { isSecretEnvVar } from '@/utils/shared/common';
import { Model } from '@/shared/types';
import { createLogger } from '@/utils/logger';
import { Settings } from '@/shared/types/storage/storage';

// Create a logger instance for this file
const log = createLogger('frontend/contexts/StorageContext');

interface StorageContextType {
  models: Model[];
  addModel: (model: Model) => Promise<void>;
  updateModel: (model: Model) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
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
  isLoading: boolean; // Add loading state
  settings: Settings; // Application settings
  updateSettings: (newSettings: Settings) => Promise<void>; // Update settings
}

const StorageContext = createContext<StorageContextType>({
  models: [],
  addModel: async () => {},
  updateModel: async () => {},
  deleteModel: async () => {},
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
    }
  },
  updateSettings: async () => {},
});

export const useStorage = () => useContext(StorageContext);

export const StorageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Track hydration status
  const [isHydrated, setIsHydrated] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [globalEnvVars, setGlobalEnvVarsState] = useState<Record<string, { value: string, metadata: { isSecret: boolean } }>>({});
  const [settings, setSettings] = useState<Settings>({
    speech: {
      enabled: true
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
        
        // Load models
        const loadedModels = await loadItem<Model[]>(StorageKey.MODELS, []);
        log.debug('Loaded models from storage', { count: loadedModels.length });
        setModels(loadedModels);
        
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
        
        // Load speech settings
        const loadedSettings = await loadItem<Settings>(StorageKey.SPEECH_SETTINGS, {
          speech: {
            enabled: true
          }
        });
        log.debug('Loaded speech settings from storage', { settings: loadedSettings });
        setSettings(loadedSettings);
        
        setIsHydrated(true);
      } catch (error) {
        log.error('loadData: Error loading data:', error);
        setIsHydrated(true); // Still set hydrated to true to avoid blocking the UI
      }
    };
    
    loadData();
  }, [isEncryptionInitialized]);

  const addModel = useCallback(async (model: Model) => {
    log.debug('addModel: Entering method');
    const updatedModels = [...models, model];
    await saveItem(StorageKey.MODELS, updatedModels);
    setModels(updatedModels);
  }, [models]);

  const updateModel = useCallback(async (model: Model) => {
    log.debug('updateModel: Entering method');
    const updatedModels = models.map(m => m.id === model.id ? model : m);
    await saveItem(StorageKey.MODELS, updatedModels);
    setModels(updatedModels);
  }, [models]);

  const deleteModel = useCallback(async (id: string) => {
    log.debug('deleteModel: Entering method');
    const updatedModels = models.filter(m => m.id !== id);
    await saveItem(StorageKey.MODELS, updatedModels);
    setModels(updatedModels);
  }, [models]);

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

  const decryptValue = useCallback(async (encryptedValue: string, password?: string): Promise<string | null> => {
    log.debug('decryptValue: Entering method');
    try {
      // Check if we have a token in session storage (from authentication)
      const sessionToken = typeof window !== 'undefined' ? sessionStorage.getItem('encryption_token') : null;
      // Check if we have a password in session storage (legacy support)
      const sessionPassword = typeof window !== 'undefined' ? sessionStorage.getItem('encryption_key') : null;
      
      // Prepare the request body
      const requestBody: any = {
        action: 'decrypt',
        data: encryptedValue
      };
      
      // Use token first, then provided password, then session password
      if (sessionToken) {
        requestBody.token = sessionToken;
      } else if (password) {
        requestBody.password = password;
      } else if (sessionPassword) {
        requestBody.password = sessionPassword;
      }
      
      // Use the secure server-side API for decryption
      const response = await fetch('/api/encryption/secure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error('Failed to decrypt value');
      }

      const data = await response.json();
      return data.result;
    } catch (error) {
      log.warn('decryptValue: Failed to decrypt value:', error);
      return null;
    }
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
        models,
        addModel,
        updateModel,
        deleteModel,
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
        updateSettings,
      }}
    >
      {children}
    </StorageContext.Provider>
  );
};

export default StorageContext;
