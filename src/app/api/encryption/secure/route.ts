import { NextRequest, NextResponse } from 'next/server';
import { 
  initializeEncryption,
  initializeDefaultEncryption,
  changeEncryptionPassword, 
  encryptWithPassword, 
  decryptWithPassword, 
  verifyPassword,
  isEncryptionInitialized,
  isUserEncryptionEnabled,
  getEncryptionType,
  authenticate,
  logout
} from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';

const log = createLogger('app/api/encryption/secure/route');

// Initialize default encryption when the module is loaded
initializeDefaultEncryption().catch(error => {
  log.error('Failed to initialize default encryption', error);
});

export async function POST(req: NextRequest) {
  const requestId = uuidv4();
  // log.info(`Handling secure encryption request`, { requestId });
  
  try {
    const { action, password, oldPassword, newPassword, data, token } = await req.json();

    if (!action) {
      log.error(`Missing action parameter`, { requestId });
      return NextResponse.json({ error: 'Action is required' }, { status: 400 });
    }

      // Handle different actions
    switch (action) {
      case 'initialize':
        log.info(`Processing initialize action`, { requestId }); // Keep as info
        if (!password) {
          log.error(`Missing password parameter`, { requestId });
          return NextResponse.json({ error: 'Password is required' }, { status: 400 });
        }
        
        const initialized = await initializeEncryption(password);
        if (!initialized) {
          log.error(`Failed to initialize encryption`, { requestId });
          return NextResponse.json({ error: 'Failed to initialize encryption' }, { status: 500 });
        }
        
        log.info(`Encryption initialized successfully`, { requestId });
        return NextResponse.json({ success: true });
        
      case 'initialize_default':
        log.info(`Processing initialize_default action`, { requestId }); // Keep as info
        const defaultInitialized = await initializeDefaultEncryption();
        if (!defaultInitialized) {
          log.error(`Failed to initialize default encryption`, { requestId });
          return NextResponse.json({ error: 'Failed to initialize default encryption' }, { status: 500 });
        }
        
        log.info(`Default encryption initialized successfully`, { requestId });
        return NextResponse.json({ success: true });
        
      case 'change_password':
        log.info(`Processing change_password action`, { requestId }); // Keep as info
        if (!oldPassword || !newPassword) {
          log.error(`Missing password parameters`, { requestId });
          return NextResponse.json({ error: 'Old and new passwords are required' }, { status: 400 });
        }
        
        const changed = await changeEncryptionPassword(oldPassword, newPassword);
        if (!changed) {
          log.error(`Failed to change encryption password`, { requestId });
          return NextResponse.json({ error: 'Failed to change encryption password' }, { status: 500 });
        }
        
        log.info(`Encryption password changed successfully`, { requestId });
        return NextResponse.json({ success: true });
        
      case 'authenticate':
        log.info(`Processing authenticate action`, { requestId }); // Keep as info
        if (!password) {
          log.error(`Missing password parameter`, { requestId });
          return NextResponse.json({ error: 'Password is required' }, { status: 400 });
        }
        
        const authToken = await authenticate(password);
        if (!authToken) {
          log.error(`Authentication failed`, { requestId });
          return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
        }
        
        log.info(`Authentication successful`, { requestId });
        return NextResponse.json({ success: true, token: authToken });
        
      case 'logout':
        log.info(`Processing logout action`, { requestId }); // Keep as info
        if (!token) {
          log.error(`Missing token parameter`, { requestId });
          return NextResponse.json({ error: 'Token is required' }, { status: 400 });
        }
        
        const loggedOut = await logout(token);
        log.info(`Logout completed`, { requestId, success: loggedOut });
        return NextResponse.json({ success: loggedOut });
        
      case 'encrypt':
        log.debug(`Processing encrypt action`, { requestId, hasToken: !!token, hasPassword: !!password }); // Keep as debug for start
        if (!data) {
          log.error(`Missing data parameter for encryption`, { requestId });
          return NextResponse.json({ error: 'Data is required' }, { status: 400 });
        }
        
        // Try to use token first, then password, then default encryption
        let encrypted;
        if (token) {
          encrypted = await encryptWithPassword(data, token, true);
        } else if (password) {
          encrypted = await encryptWithPassword(data, password, false);
        } else {
          encrypted = await encryptWithPassword(data);
        }
        
        if (!encrypted) {
          log.error(`Failed to encrypt data`, { requestId });
          return NextResponse.json({ error: 'Failed to encrypt data' }, { status: 500 });
        }
        
        log.debug(`Data encrypted successfully`, { requestId }); // Changed to debug
        return NextResponse.json({ result: encrypted });
        
      case 'verify_password':
        log.debug(`Processing verify_password action`, { requestId }); // Keep as debug for start
        if (!password) {
          log.error(`Missing password parameter`, { requestId });
          return NextResponse.json({ error: 'Password is required' }, { status: 400 });
        }
        
        const verifyResult = await verifyPassword(password);
        log.debug(`Password verification completed`, { requestId, valid: verifyResult.valid }); // Changed to debug
        return NextResponse.json({ 
          valid: verifyResult.valid,
          token: verifyResult.token // Return the token if password is valid
        });
        
      case 'check_initialized':
        log.debug(`Processing check_initialized action`, { requestId }); // Keep as debug for start
        const isInitialized = await isEncryptionInitialized();
        log.debug(`Initialization check completed`, { requestId, isInitialized }); // Keep as debug
        return NextResponse.json({ initialized: isInitialized });
        
      case 'check_user_encryption':
        log.debug(`Processing check_user_encryption action`, { requestId }); // Keep as debug for start
        const isUserEnabled = await isUserEncryptionEnabled();
        log.debug(`User encryption check completed`, { requestId, isUserEnabled }); // Keep as debug
        return NextResponse.json({ userEncryption: isUserEnabled });
        
      case 'get_encryption_type':
        log.debug(`Processing get_encryption_type action`, { requestId }); // Keep as debug for start
        const encryptionType = await getEncryptionType();
        log.debug(`Encryption type check completed`, { requestId, encryptionType }); // Keep as debug
        return NextResponse.json({ type: encryptionType });
        
      default:
        log.error(`Invalid action`, { requestId, action });
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    log.error(`Error processing request`, { requestId, error });
    return NextResponse.json({ 
      error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    }, { status: 500 });
  }
}
