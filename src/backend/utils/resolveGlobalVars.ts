'use server';

import { createLogger } from '@/utils/logger';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { decryptWithPassword } from '@/utils/encryption/secure';

const log = createLogger('utils/shared/server');

// Define interfaces for the new environment variable structure
interface EnvVarMetadata {
  isSecret: boolean;
}

interface EnvVarWithMetadata {
  value: string;
  metadata: EnvVarMetadata;
}

// Helper function to check if the stored data is in the new format
function isNewFormat(data: any): data is Record<string, EnvVarWithMetadata> {
  if (!data || typeof data !== 'object') return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return true; // Empty object is valid
  
  // Check if the first entry has the expected structure
  const firstKey = keys[0];
  const firstValue = data[firstKey];
  return (
    firstValue &&
    typeof firstValue === 'object' &&
    'value' in firstValue &&
    'metadata' in firstValue &&
    typeof firstValue.metadata === 'object' &&
    'isSecret' in firstValue.metadata
  );
}

/**
 * SERVER ONLY: Recursively resolve global variable references in a value
 * This function must only be used in server-side code.
 * 
 * Searches for patterns like ${global:VARIABLE_NAME} and replaces them
 * with the corresponding value from the global environment variables.
 * 
 * Handles encrypted global variables by decrypting them when needed.
 */
export async function resolveGlobalVars(value: unknown): Promise<unknown> {
  log.debug('Entering resolveGlobalVars method');

  // Load global environment variables
  const rawEnvVars = await loadItem<Record<string, string> | Record<string, EnvVarWithMetadata>>(
    StorageKey.GLOBAL_ENV_VARS, 
    {}
  );
  
  // Check if we need to handle the new format
  const isNewFormatData = isNewFormat(rawEnvVars);
  log.debug(`Loaded ${Object.keys(rawEnvVars).length} global environment variables (${isNewFormatData ? 'new' : 'old'} format)`);
  
  // Extract values from the environment variables
  let globalEnvVars: Record<string, string> = {};
  
  if (isNewFormatData) {
    // New format with metadata
    const typedEnvVars = rawEnvVars as Record<string, EnvVarWithMetadata>;
    for (const [key, data] of Object.entries(typedEnvVars)) {
      globalEnvVars[key] = data.value;
    }
  } else {
    // Old format (simple key-value pairs)
    globalEnvVars = { ...rawEnvVars as Record<string, string> };
  }
  
  // Helper function to resolve a single string
  const resolveString = async (str: string): Promise<string> => {
    // Use a regex that captures the entire pattern including the braces
    const regex = /\$\{global:([^}]+)\}/g;
    const matches = str.match(regex);
    
    // If no matches, return the original string
    if (!matches) return str;
    
    // Process each match
    let result = str;
    for (const match of matches) {
      // Extract the variable key from the match
      const globalVarKey = match.substring(9, match.length - 1);
      
      if (globalEnvVars[globalVarKey] !== undefined) {
        let value = globalEnvVars[globalVarKey];
        
        // Check if the value is encrypted
        if (value.startsWith('encrypted:')) {
          log.debug(`Decrypting encrypted global variable: ${globalVarKey}`);
          try {
            // Extract the encrypted value (remove 'encrypted:' prefix)
            const encryptedValue = value.substring(10);
            // Decrypt the value
            const decryptedValue = await decryptWithPassword(encryptedValue);
            
            if (decryptedValue) {
              value = decryptedValue;
              log.debug(`Successfully decrypted global variable: ${globalVarKey}`);
            } else {
              log.warn(`Failed to decrypt global variable: ${globalVarKey}`);
              // Keep the original reference if decryption fails
              continue;
            }
          } catch (error) {
            log.error(`Error decrypting global variable: ${globalVarKey}`, error);
            // Keep the original reference if decryption fails
            continue;
          }
        } else if (value.startsWith('encrypted_failed:')) {
          log.warn(`Skipping failed encrypted global variable: ${globalVarKey}`);
          // Keep the original reference for failed encryptions
          continue;
        }
        
        log.debug(`Resolved global variable: ${globalVarKey}`);
        // Replace the match with the resolved value
        result = result.replace(match, value);
      } else {
        log.warn(`Global variable not found: ${globalVarKey}`);
        // Keep original if not found (no replacement needed)
      }
    }
    
    return result;
  };
  
  // Recursively process the value
  const processValue = async (val: unknown): Promise<unknown> => {
    if (typeof val === 'string') {
      return await resolveString(val);
    } else if (Array.isArray(val)) {
      return await Promise.all(val.map(item => processValue(item)));
    } else if (val !== null && typeof val === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        result[k] = await processValue(v);
      }
      return result;
    }
    return val;
  };

  const result = await processValue(value);
  
  // Log the entire resolved object for debugging
  if (typeof value === 'object' && value !== null) {
    log.debug('Resolved global variables result:', JSON.stringify(result, null, 2));
  }
  
  log.debug('Completed global variable resolution');
  return result;
}

/**
 * Helper function to resolve and decrypt an API key
 * This handles both global variable references and encrypted values
 */
export async function resolveAndDecryptApiKey(encryptedApiKey: string): Promise<string | null> {
  log.debug('Entering resolveAndDecryptApiKey method');
  
  if (!encryptedApiKey) {
    log.warn('Empty API key provided');
    return null;
  }
  
  // Check if the API key is a global variable reference
  const globalVarMatch = encryptedApiKey.match(/\$\{global:([^}]+)\}/);
  if (globalVarMatch) {
    // It's a global variable reference, resolve it
    const resolved = await resolveGlobalVars(encryptedApiKey) as string;
    if (resolved === encryptedApiKey) {
      // If it wasn't resolved (global var not found), return null
      log.warn(`Failed to resolve global variable in API key: ${encryptedApiKey}`);
      return null;
    }
    return resolved;
  }
  
  // It's an encrypted value, decrypt it
  try {
    const decrypted = await decryptWithPassword(encryptedApiKey);
    if (!decrypted) {
      log.warn('Failed to decrypt API key');
      return null;
    }
    return decrypted;
  } catch (error) {
    log.error('Error decrypting API key:', error);
    return null;
  }
}
