# Encryption Utilities

This directory contains the encryption utilities used throughout the application for secure data protection. The encryption system provides a robust, two-tier approach to data security with both default and user-defined encryption options.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Files](#files)
  - [index.ts](#indexts)
  - [secure.ts](#securets)
  - [session.ts](#sessionts)
- [Key Concepts](#key-concepts)
  - [Data Encryption Key (DEK)](#data-encryption-key-dek)
  - [Two-Tier Encryption](#two-tier-encryption)
  - [Session-Based Authentication](#session-based-authentication)
- [Usage Examples](#usage-examples)
- [Security Considerations](#security-considerations)

## Overview

The encryption utilities provide a comprehensive system for protecting sensitive data within the application. Key features include:

- **Two-tier encryption**: Default encryption that works automatically and user-defined encryption for enhanced security
- **Session-based authentication**: Secure token-based authentication that avoids storing passwords
- **Data Encryption Key (DEK) approach**: Separates the encryption key from the user's password
- **Secure key derivation**: Uses PBKDF2 with 100,000 iterations for strong key derivation
- **Automatic session expiration**: Sessions automatically expire after 2 hours of inactivity

## Architecture

The encryption system follows a layered architecture:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│  Frontend       │◄───►│  API Layer      │◄───►│  Encryption     │
│  Components     │     │  (Secure API)   │     │  Utilities      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                                ┌─────────────────┐
                                                │                 │
                                                │  Session        │
                                                │  Management     │
                                                └─────────────────┘
```

## Files

### index.ts

This file serves as the main entry point for the encryption utilities, re-exporting the secure encryption functions and providing compatibility functions for API key encryption.

#### Key Functions

- `encryptApiKey(value: string, key?: string)`: Encrypts an API key with optional password
- `decryptApiKey(encryptedValue: string, key?: string)`: Decrypts an API key with optional password

### secure.ts

This file contains the core encryption functionality, implementing the two-tier encryption system with Data Encryption Keys (DEK).

#### Key Functions

- `initializeEncryption(password: string)`: Initializes user-defined encryption
- `initializeDefaultEncryption()`: Initializes default encryption
- `encryptWithPassword(text: string, passwordOrToken?: string, isToken?: boolean)`: Encrypts data
- `decryptWithPassword(ciphertext: string, passwordOrToken?: string, isToken?: boolean)`: Decrypts data
- `verifyPassword(password: string)`: Verifies a password and returns a session token
- `authenticate(password: string)`: Authenticates with a password and returns a session token
- `logout(token: string)`: Invalidates a session token
- `changeEncryptionPassword(oldPassword: string, newPassword: string)`: Changes the encryption password
- `isEncryptionInitialized()`: Checks if encryption is initialized
- `isUserEncryptionEnabled()`: Checks if user encryption is enabled
- `getEncryptionType()`: Returns the current encryption type

### session.ts

This file implements the session management system for secure authentication without storing passwords.

#### Key Functions

- `createSession(dek: string)`: Creates a new session with the provided DEK
- `getDekFromSession(token: string)`: Retrieves the DEK from a session
- `invalidateSession(token: string)`: Invalidates a session

## Key Concepts

### Data Encryption Key (DEK)

The encryption system uses a Data Encryption Key (DEK) approach:

1. A random DEK is generated for encrypting actual data
2. The DEK is encrypted with a key derived from the user's password
3. For encryption/decryption operations, the DEK is first decrypted, then used to encrypt/decrypt the data

Benefits of this approach:
- Password changes don't require re-encrypting all data
- Multiple encryption schemes can use the same underlying DEK
- Adds an additional layer of security

### Two-Tier Encryption

The system supports two encryption modes:

1. **Default Encryption**: Automatically initialized, provides basic security without requiring user setup
2. **User Encryption**: Requires a user-defined password, provides enhanced security

The system automatically falls back to default encryption if user encryption fails, ensuring data is always protected.

### Session-Based Authentication

The session management system provides secure authentication without storing passwords:

1. When a user authenticates with their password, the system verifies the password
2. If valid, the system creates a session and stores the DEK in memory
3. A secure session token is returned to the client
4. For subsequent operations, the client sends the token instead of the password
5. Sessions automatically expire after 2 hours of inactivity

Benefits:
- Passwords are never stored in the browser
- Reduced risk of credential exposure
- Automatic session expiration for enhanced security

## Usage Examples

### Encrypting Data

```typescript
// With a password
const encrypted = await encryptWithPassword('sensitive data', 'user-password');

// With a session token
const encrypted = await encryptWithPassword('sensitive data', sessionToken, true);

// With default encryption
const encrypted = await encryptWithPassword('sensitive data');
```

### Decrypting Data

```typescript
// With a password
const decrypted = await decryptWithPassword(encryptedData, 'user-password');

// With a session token
const decrypted = await decryptWithPassword(encryptedData, sessionToken, true);

// With default encryption
const decrypted = await decryptWithPassword(encryptedData);
```

### Authentication

```typescript
// Verify a password and get a session token
const result = await verifyPassword('user-password');
if (result.valid && result.token) {
  // Store the token for future operations
  const sessionToken = result.token;
}

// Authenticate and get a session token
const sessionToken = await authenticate('user-password');

// Logout (invalidate a session)
await logout(sessionToken);
```

## Security Considerations

### Password Handling

- Passwords are never stored in plain text
- Password-derived keys use PBKDF2 with 100,000 iterations
- Random salt for each password
- 256-bit encryption keys

### Session Security

- Sessions are stored in memory only
- Sessions automatically expire after 2 hours
- Session tokens are cryptographically random UUIDs
- Sessions can be explicitly invalidated

### Encryption Strength

- Uses AES-256-CBC for encryption
- Random IV for each encryption operation
- PKCS#7 padding
- Secure key derivation with PBKDF2
