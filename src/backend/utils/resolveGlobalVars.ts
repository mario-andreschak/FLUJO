'use server';

import { createLogger } from '@/utils/logger';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { decryptWithPassword } from '@/utils/encryption/secure';

const log = createLogger('backend/utils/resolveGlobalVars');

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
  const resolveString = async (str: string, currentValue: unknown): Promise<string> => {
    // Use a regex that captures the entire pattern including the braces
    // Match both ${global:VAR} and ${VAR} patterns
    const regex = /\$\{(?:global:)?([^}]+)\}/g;
    const matches = str.match(regex);
    
    // If no matches, return the original string
    if (!matches) return str;
    
    // Process each match
    let result = str;
    let madeReplacement = false;  // Add this flag to track if we made any changes
    
    for (const match of matches) {
      // Extract the variable key from the match
      const varKey = match.includes('global:') 
        ? match.substring(9, match.length - 1)  // Remove ${global: and }
        : match.substring(2, match.length - 1); // Remove ${ and }
      
      // First try to resolve from the current environment variables
      let resolved = false;
      if (typeof currentValue === 'object' && currentValue !== null) {
        const envVars = 'env' in currentValue 
          ? currentValue.env as Record<string, string>
          : currentValue as Record<string, string>;
        
        if (varKey in envVars) {
          const envValue = envVars[varKey];
          const resolvedValue = await resolveString(envValue, envVars);
          result = result.replace(match, resolvedValue);
          resolved = true;
          madeReplacement = true;  // Set flag when we make a replacement
          log.debug(`Resolved environment variable: ${varKey} = ${resolvedValue}`);
        }
      }
      
      // If not resolved from env, try global variables
      if (!resolved) {
        const globalValue = globalEnvVars[varKey];
        if (globalValue !== undefined) {
          if (globalValue.startsWith('encrypted:')) {
            log.debug(`Decrypting encrypted global variable: ${varKey}`);
            try {
              // Extract the encrypted value (remove 'encrypted:' prefix)
              const encryptedValue = globalValue.substring(10);
              // Decrypt the value
              const decryptedValue = await decryptWithPassword(encryptedValue);
              
              if (decryptedValue) {
                result = result.replace(match, decryptedValue);
                madeReplacement = true;  // Set flag when we make a replacement
                log.debug(`Successfully decrypted global variable: ${varKey}`);
              } else {
                log.warn(`Failed to decrypt global variable: ${varKey}`);
                // Keep the original reference if decryption fails
              }
            } catch (error) {
              log.error(`Error decrypting global variable: ${varKey}`, error);
              // Keep the original reference if decryption fails
            }
          } else if (globalValue.startsWith('encrypted_failed:')) {
            log.warn(`Skipping failed encrypted global variable: ${varKey}`);
            // Keep the original reference for failed encryptions
          } else {
            result = result.replace(match, globalValue);
            madeReplacement = true;  // Set flag when we make a replacement
            log.debug(`Resolved global variable: ${varKey}`);
          }
        } else {
          log.warn(`Variable not found: ${varKey}`);
          // Keep original if not found (no replacement needed)
        }
      }
    }
    
    // Only recursively resolve if we actually made replacements
    const remainingMatches = result.match(regex);
    if (remainingMatches && madeReplacement) {
      result = await resolveString(result, currentValue);
    }
    
    return result;
  };
  
  // Recursively process the value
  const processValue = async (val: unknown): Promise<unknown> => {
    if (typeof val === 'string') {
      return await resolveString(val, value);
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
 * Helper function to resolve and decrypt an API key or global variable
 * This handles both global variable references and encrypted values
 * 
 * The process follows this order:
 * 1. Decrypt (if encrypted)
 * 2. Resolve global variables (if it contains references)
 * 3. Repeat from step 1 if necessary (up to 10 levels deep)
 * 
 * @param value The value to resolve and decrypt
 * @param depth Current recursion depth (used internally)
 * @returns The resolved and decrypted value, or null if resolution failed
 */
export async function resolveAndDecryptApiKey(
  value: string, 
  depth: number = 0
): Promise<string | null> {
  log.debug(`Entering resolveAndDecryptApiKey method (depth: ${depth})`);
  
  // Check for empty input
  if (!value) {
    log.warn('Empty value provided');
    return null;
  }
  
  // Add depth limit to prevent infinite recursion
  if (depth >= 10) {
    log.warn(`Maximum resolution depth reached (10) for value: ${value}`);
    return value;
  }
  
  let currentValue = value;
  
  // Step 1: Decrypt if encrypted
  if (currentValue.startsWith('encrypted:')) {
    log.debug(`Decrypting encrypted value at depth ${depth}`);
    try {
      const encryptedValue = currentValue.substring(10); // Remove 'encrypted:' prefix
      const decrypted = await decryptWithPassword(encryptedValue);
      
      if (decrypted) {
        log.debug(`Successfully decrypted value at depth ${depth}`);
        log.verbose(decrypted)
        currentValue = decrypted;
      } else {
        log.warn(`Failed to decrypt value at depth ${depth}`);
        return null;
      }
    } catch (error) {
      log.error(`Error decrypting value at depth ${depth}:`, error);
      return null;
    }
  } else if (currentValue.startsWith('encrypted_failed:')) {
    log.warn(`Skipping failed encrypted value at depth ${depth}`);
    currentValue = currentValue.substring('encrypted_failed:'.length);
  }
  
  // Step 2: Resolve global variables
  if (currentValue.includes('${global:')) {
    log.debug(`Resolving global variables at depth ${depth}`);
    try {
      const resolved = await resolveGlobalVars(currentValue) as string;
      log.verbose(resolved)
      // If the value changed after resolution, process it again recursively
      if (resolved !== currentValue) {
        log.debug(`Value changed after resolving globals at depth ${depth}, processing recursively`);
        return resolveAndDecryptApiKey(resolved, depth + 1);
      }
      
      currentValue = resolved;
    } catch (error) {
      log.error(`Error resolving global variables at depth ${depth}:`, error);
      return null;
    }
  }
  
  log.debug(`Completed resolveAndDecryptApiKey at depth ${depth}`);
  return currentValue;
}
