# Secure Encryption API Layer

This directory contains the API layer for the Secure Encryption service implementation. The API layer provides a secure interface for encryption and decryption operations throughout the application.

## Architecture

The Secure Encryption implementation follows a clean architecture pattern with clear separation of concerns:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  UI Components  │◄───►│  StorageContext │◄───►│  API Layer      │◄───┐
│  (Auth Dialog)  │     │  (Provider)     │     │  (route.ts)     │    │
└─────────────────┘     └─────────────────┘     └─────────────────┘    │
                                                        │               │
                                                        ▼               │
                                                ┌─────────────────┐     │
                                                │                 │     │
                                                │  Encryption     │◄────┘
                                                │  Utilities      │
                                                └─────────────────┘
```

## Components

### API Handler

- `route.ts`: Handles HTTP requests for encryption operations, validates inputs, and delegates to the encryption utilities

### Encryption Utilities

The core encryption functionality is implemented in `@/utils/encryption/secure.ts`, which provides:

- Two-tier encryption system (default and user-defined)
- Data Encryption Key (DEK) management
- Password-based encryption and decryption
- Password verification and change

### Frontend Integration

- `StorageContext`: Provides encryption-related functions to frontend components
- `EncryptionAuthDialog`: UI component for password authentication

## Flow of Control

1. Frontend components use the StorageContext to interact with encryption functionality
2. StorageContext makes API calls to the secure encryption API
3. API handler validates inputs and delegates to the encryption utilities
4. Encryption utilities perform the requested operations
5. Results are returned through the API to the frontend

## Security Features

### Two-Tier Encryption System

The encryption system supports two modes:

1. **Default Encryption**: Automatically initialized, provides basic security without requiring user setup
2. **User Encryption**: Requires a user-defined password, provides enhanced security

### Data Encryption Key (DEK) Approach

Rather than directly encrypting data with the user's password:

1. A random Data Encryption Key (DEK) is generated
2. The DEK is encrypted with a key derived from the user's password
3. Data is encrypted with the DEK

This approach provides several benefits:
- Password changes don't require re-encrypting all data
- Multiple encryption schemes can use the same underlying DEK
- Adds an additional layer of security

### Secure Key Derivation

- Uses PBKDF2 with 100,000 iterations for key derivation
- Random salt for each password
- 256-bit encryption keys

### Error Handling and Fallbacks

- Graceful fallback to default encryption when user encryption fails
- Comprehensive error logging
- Secure error messages that don't leak sensitive information

## API Endpoints

The API exposes a single POST endpoint that supports multiple actions:

### Initialize Encryption

```json
{
  "action": "initialize",
  "password": "user-password"
}
```
Initializes the encryption system with a user-defined password.

### Initialize Default Encryption

```json
{
  "action": "initialize_default"
}
```
Initializes the encryption system with default encryption (no password required).

### Change Password

```json
{
  "action": "change_password",
  "oldPassword": "current-password",
  "newPassword": "new-password"
}
```
Changes the encryption password from `oldPassword` to `newPassword`.

### Encrypt Data

```json
{
  "action": "encrypt",
  "data": "data-to-encrypt",
  "password": "user-password" // Optional
}
```
Encrypts the provided data. If password is omitted, uses default encryption.

### Decrypt Data

```json
{
  "action": "decrypt",
  "data": "encrypted-data",
  "password": "user-password" // Optional
}
```
Decrypts the provided data. If password is omitted, uses default encryption.

### Verify Password

```json
{
  "action": "verify_password",
  "password": "user-password"
}
```
Verifies if the provided password is correct.

### Check Initialization Status

```json
{
  "action": "check_initialized"
}
```
Checks if the encryption system has been initialized.

### Check User Encryption Status

```json
{
  "action": "check_user_encryption"
}
```
Checks if user encryption is enabled.

### Get Encryption Type

```json
{
  "action": "get_encryption_type"
}
```
Returns the current encryption type (default or user).

## Usage Examples

### Frontend Usage via StorageContext

```typescript
import { useStorage } from '@/frontend/contexts/StorageContext';

// In a component
const { 
  encryptValue, 
  decryptValue, 
  verifyKey, 
  isEncryptionInitialized,
  isUserEncryptionEnabled
} = useStorage();

// Encrypt a value
const encrypted = await encryptValue('sensitive data');

// Decrypt a value
const decrypted = await decryptValue(encrypted);

// Verify a password
const isValid = await verifyKey('user-password');

// Check if encryption is initialized
const initialized = await isEncryptionInitialized();

// Check if user encryption is enabled
const userEncryption = await isUserEncryptionEnabled();
```

### Direct API Usage

```typescript
// Encrypt data
const encryptResponse = await fetch('/api/encryption/secure', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'encrypt',
    data: 'sensitive data',
    password: 'optional-password'
  })
});
const { result: encryptedData } = await encryptResponse.json();

// Decrypt data
const decryptResponse = await fetch('/api/encryption/secure', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'decrypt',
    data: encryptedData,
    password: 'optional-password'
  })
});
const { result: decryptedData } = await decryptResponse.json();
```

## Error Handling

The API returns appropriate HTTP status codes and error messages:

- `400 Bad Request`: Missing or invalid parameters
- `500 Internal Server Error`: Server-side errors

Error responses include a descriptive message:

```json
{
  "error": "Error message"
}
```

Success responses include a success flag or result data:

```json
{
  "success": true
}
```

or

```json
{
  "result": "operation-result"
}
```
