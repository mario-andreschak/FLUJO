import { NextRequest, NextResponse } from 'next/server';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { encryptWithPassword, decryptWithPassword } from '@/utils/encryption/secure';
import { isSecretEnvVar } from '@/utils/shared';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 } from 'uuid';
const uuidv4 = v4;

const log = createLogger('app/api/env/route');

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

// Helper function to migrate old format to new format
function migrateToNewFormat(oldData: Record<string, string>): Record<string, EnvVarWithMetadata> {
  const newData: Record<string, EnvVarWithMetadata> = {};
  
  for (const [key, value] of Object.entries(oldData)) {
    // Determine if this is a secret based on the key or if it's already encrypted
    const isSecret = isSecretEnvVar(key) || 
                    (typeof value === 'string' && 
                     (value.startsWith('encrypted:') || value.startsWith('encrypted_failed:')));
    
    newData[key] = {
      value,
      metadata: {
        isSecret
      }
    };
  }
  
  return newData;
}

/**
 * API route for environment variable operations
 * This moves sensitive operations like encryption and decryption to the server
 */

// GET handler for retrieving environment variables
export async function GET(req: NextRequest) {
  const requestId = uuidv4();
  log.debug(`Handling GET request [${requestId}]`);
  
  try {
    const url = new URL(req.url);
    const key = url.searchParams.get('key');
    const includeSecrets = url.searchParams.get('includeSecrets') === 'true';
    
    // Load all environment variables
    const rawEnvVars = await loadItem<Record<string, string> | Record<string, EnvVarWithMetadata>>(
      StorageKey.GLOBAL_ENV_VARS, 
      {}
    );
    
    // Check if we need to migrate from old format to new format
    const envVars = isNewFormat(rawEnvVars) 
      ? rawEnvVars 
      : migrateToNewFormat(rawEnvVars as Record<string, string>);
    
    // If a specific key is requested, return just that value
    if (key) {
      log.debug(`Getting specific env var: ${key} [${requestId}]`);
      const envVar = envVars[key];
      
      if (!envVar) {
        return NextResponse.json({ value: undefined });
      }
      
      const value = envVar.value;
      const isSecret = envVar.metadata.isSecret;
      
      // If the value is encrypted (starts with 'encrypted:'), decrypt it
      if (value && typeof value === 'string' && value.startsWith('encrypted:')) {
        // Only decrypt if includeSecrets is true
        if (includeSecrets) {
          log.debug(`Decrypting secret env var: ${key} [${requestId}]`);
          const encryptedValue = value.substring(10); // Remove 'encrypted:' prefix
          const decryptedValue = await decryptWithPassword(encryptedValue);
          return NextResponse.json({ 
            value: decryptedValue || '********',
            metadata: { isSecret }
          });
        } else {
          // Return a placeholder for secret values
          return NextResponse.json({ 
            value: '********',
            metadata: { isSecret }
          });
        }
      }
      
      // Check if this is a failed encryption marker
      if (value && typeof value === 'string' && value.startsWith('encrypted_failed:')) {
        log.debug(`Found failed encryption marker for: ${key} [${requestId}]`);
        // Always return asterisks for failed encryptions
        return NextResponse.json({ 
          value: '********',
          metadata: { isSecret }
        });
      }
      
      // Return the value as-is if it's not encrypted
      return NextResponse.json({ 
        value,
        metadata: { isSecret }
      });
    }
    
    // If no specific key is requested, return all environment variables
    // Process each variable to handle encrypted values
    const processedEnvVars: Record<string, { value: string, metadata: EnvVarMetadata }> = {};
    
    for (const [varKey, envVar] of Object.entries(envVars)) {
      const value = envVar.value;
      const isSecret = envVar.metadata.isSecret;
      
      if (value && typeof value === 'string') {
        if (value.startsWith('encrypted:')) {
          // Only decrypt if includeSecrets is true
          if (includeSecrets) {
            log.debug(`Decrypting secret env var: ${varKey} [${requestId}]`);
            const encryptedValue = value.substring(10); // Remove 'encrypted:' prefix
            const decryptedValue = await decryptWithPassword(encryptedValue);
            processedEnvVars[varKey] = {
              value: decryptedValue || '********',
              metadata: { isSecret }
            };
          } else {
            // Return a placeholder for secret values
            processedEnvVars[varKey] = {
              value: '********',
              metadata: { isSecret }
            };
          }
        } else if (value.startsWith('encrypted_failed:')) {
          // Always return asterisks for failed encryptions
          processedEnvVars[varKey] = {
            value: '********',
            metadata: { isSecret }
          };
        } else {
          // Not encrypted, return as-is
          processedEnvVars[varKey] = {
            value,
            metadata: { isSecret }
          };
        }
      } else {
        // Handle null or undefined values
        processedEnvVars[varKey] = {
          value: value || '',
          metadata: { isSecret }
        };
      }
    }
    
    return NextResponse.json({ variables: processedEnvVars });
  } catch (error) {
    log.error('Environment variables API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}

// POST handler for setting environment variables
export async function POST(req: NextRequest) {
  const requestId = uuidv4();
  log.debug(`Handling POST request [${requestId}]`);
  
  try {
    const { action, key, value, metadata, variables } = await req.json();
    
    // Load current environment variables
    const rawEnvVars = await loadItem<Record<string, string> | Record<string, EnvVarWithMetadata>>(
      StorageKey.GLOBAL_ENV_VARS, 
      {}
    );
    
    // Check if we need to migrate from old format to new format
    const envVars = isNewFormat(rawEnvVars) 
      ? rawEnvVars as Record<string, EnvVarWithMetadata>
      : migrateToNewFormat(rawEnvVars as Record<string, string>);
    
    if (action === 'set') {
      log.debug(`Setting single env var: ${key} [${requestId}]`);
      // Set a single environment variable
      if (!key) {
        return NextResponse.json({ error: 'Key is required' }, { status: 400 });
      }
      
      // Get the isSecret flag from metadata or fall back to checking the key
      const isSecret = metadata?.isSecret ?? isSecretEnvVar(key);
      const stringValue = String(value || '');
      
      // Silently ignore the placeholder value
      if (stringValue === '********') {
        log.debug(`Ignoring placeholder value for: ${key} [${requestId}]`);
        return NextResponse.json({ success: true });
      }
      
      // If it's a secret and not already a binding reference, encrypt it
      if (isSecret && stringValue && !stringValue.startsWith('${global:')) {
        log.debug(`Encrypting secret env var: ${key} [${requestId}]`);
        try {
          // First check if encryption is initialized
          const isEncryptionInitialized = await import('@/utils/encryption/secure').then(
            module => module.isEncryptionInitialized()
          );
          
          if (!isEncryptionInitialized) {
            log.debug(`Initializing default encryption [${requestId}]`);
            // Initialize default encryption if not already initialized
            await import('@/utils/encryption/secure').then(
              module => module.initializeDefaultEncryption()
            );
          }
          
          const encryptedValue = await encryptWithPassword(stringValue);
          if (encryptedValue) {
            // Store with a prefix to identify encrypted values
            envVars[key] = {
              value: `encrypted:${encryptedValue}`,
              metadata: { isSecret }
            };
          } else {
            // If encryption fails, mark it as a failed encryption
            // This will be handled by the UI to show asterisks
            envVars[key] = {
              value: `encrypted_failed:${stringValue}`,
              metadata: { isSecret }
            };
            log.error(`Failed to encrypt environment variable: ${key}`);
          }
        } catch (error) {
          log.error(`Error encrypting environment variable: ${key}`, error);
          // Mark as failed encryption
          envVars[key] = {
            value: `encrypted_failed:${stringValue}`,
            metadata: { isSecret }
          };
        }
      } else {
        // Store non-secret values as-is
        envVars[key] = {
          value: stringValue,
          metadata: { isSecret }
        };
      }
      
      // Save the updated environment variables
      await saveItem(StorageKey.GLOBAL_ENV_VARS, envVars);
      
      return NextResponse.json({ success: true });
    } else if (action === 'setAll') {
      log.debug(`Setting multiple env vars [${requestId}]`);
      // Set multiple environment variables at once
      if (!variables || typeof variables !== 'object') {
        return NextResponse.json({ error: 'Variables object is required' }, { status: 400 });
      }
      
      // Process each variable
      const varsToStore: Record<string, EnvVarWithMetadata> = { ...envVars };
      
      for (const [varKey, varData] of Object.entries(variables)) {
        // Extract value and metadata from the variable data
        const varValue = typeof varData === 'object' && varData !== null && 'value' in varData
          ? (varData as any).value
          : varData;
          
        const varMetadata = typeof varData === 'object' && varData !== null && 'metadata' in varData
          ? (varData as any).metadata
          : { isSecret: isSecretEnvVar(varKey) };
        
        // Get the isSecret flag from metadata
        const isSecret = varMetadata?.isSecret ?? isSecretEnvVar(varKey);
        const stringValue = String(varValue || '');
        
        // Silently ignore the placeholder value
        if (stringValue === '********') {
          log.debug(`Ignoring placeholder value for: ${varKey} [${requestId}]`);
          continue; // Skip this variable and move to the next one
        }
        
        // If it's a secret and not already a binding reference, encrypt it
        if (isSecret && stringValue && !stringValue.startsWith('${global:')) {
          log.debug(`Encrypting secret env var: ${varKey} [${requestId}]`);
          try {
            // First check if encryption is initialized
            const isEncryptionInitialized = await import('@/utils/encryption/secure').then(
              module => module.isEncryptionInitialized()
            );
            
            if (!isEncryptionInitialized) {
              log.debug(`Initializing default encryption [${requestId}]`);
              // Initialize default encryption if not already initialized
              await import('@/utils/encryption/secure').then(
                module => module.initializeDefaultEncryption()
              );
            }
            
            const encryptedValue = await encryptWithPassword(stringValue);
            if (encryptedValue) {
              // Store with a prefix to identify encrypted values
              varsToStore[varKey] = {
                value: `encrypted:${encryptedValue}`,
                metadata: { isSecret }
              };
            } else {
              // If encryption fails, mark it as a failed encryption
              // This will be handled by the UI to show asterisks
              varsToStore[varKey] = {
                value: `encrypted_failed:${stringValue}`,
                metadata: { isSecret }
              };
              log.error(`Failed to encrypt environment variable: ${varKey}`);
            }
          } catch (error) {
            log.error(`Error encrypting environment variable: ${varKey}`, error);
            // Mark as failed encryption
            varsToStore[varKey] = {
              value: `encrypted_failed:${stringValue}`,
              metadata: { isSecret }
            };
          }
        } else {
          // Store non-secret values as-is
          varsToStore[varKey] = {
            value: stringValue,
            metadata: { isSecret }
          };
        }
      }
      
      // Save the updated environment variables
      await saveItem(StorageKey.GLOBAL_ENV_VARS, varsToStore);
      
      return NextResponse.json({ success: true });
    } else if (action === 'delete') {
      log.debug(`Deleting env var: ${key} [${requestId}]`);
      // Delete an environment variable
      if (!key) {
        return NextResponse.json({ error: 'Key is required' }, { status: 400 });
      }
      
      // Remove the variable
      delete envVars[key];
      
      // Save the updated environment variables
      await saveItem(StorageKey.GLOBAL_ENV_VARS, envVars);
      
      return NextResponse.json({ success: true });
    } else {
      log.warn(`Invalid action: ${action} [${requestId}]`);
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error('Environment variables API error:', error);
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}

