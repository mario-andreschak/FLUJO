import { createSession, getDekFromSession, invalidateSession } from '../session';

// Mock uuid to return sequential values
let uuidCounter = 0;
jest.mock('uuid', () => ({
  v4: jest.fn(() => `mock-uuid-token-${uuidCounter++}`)
}));

// Mock logger
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('Encryption Session Management', () => {
  // Mock Date.now to control time
  const originalDateNow = Date.now;
  const mockNow = 1609459200000; // 2021-01-01T00:00:00.000Z
  
  beforeAll(() => {
    Date.now = jest.fn(() => mockNow);
  });
  
  afterAll(() => {
    Date.now = originalDateNow;
  });
  
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the UUID counter before each test
    uuidCounter = 0;
    // Clear sessions
    invalidateSession('mock-uuid-token-0');
    invalidateSession('mock-uuid-token-1');
    invalidateSession('mock-uuid-token-2');
  });
  
  describe('createSession', () => {
    test('should create a new session with the provided DEK', () => {
      const dek = 'test-dek-value';
      
      const token = createSession(dek);
      
      expect(token).toBe('mock-uuid-token-0');
      
      // Verify session was created by trying to retrieve the DEK
      const retrievedDek = getDekFromSession(token);
      expect(retrievedDek).toBe(dek);
    });
  });
  
  describe('getDekFromSession', () => {
    test('should return the DEK for a valid session', () => {
      const dek = 'test-dek-value';
      const token = createSession(dek);
      
      const retrievedDek = getDekFromSession(token);
      
      expect(retrievedDek).toBe(dek);
    });
    
    test('should return null for an invalid session', () => {
      const retrievedDek = getDekFromSession('non-existent-token');
      
      expect(retrievedDek).toBeNull();
    });
    
    test('should return null for an expired session', () => {
      // Create a session
      const dek = 'test-dek-value';
      const token = createSession(dek);
      
      // Fast-forward time to expire the session (2 hours + 1 ms)
      const expirationTime = 2 * 60 * 60 * 1000 + 1;
      const expiredTime = mockNow + expirationTime;
      (Date.now as jest.Mock).mockReturnValue(expiredTime);
      
      const retrievedDek = getDekFromSession(token);
      
      expect(retrievedDek).toBeNull();
    });
    
    test('should update lastUsed timestamp for valid sessions', () => {
      const dek = 'test-dek-value';
      const token = createSession(dek);
      
      // Advance time by 1 hour
      const oneHourLater = mockNow + 60 * 60 * 1000;
      (Date.now as jest.Mock).mockReturnValue(oneHourLater);
      
      // This should update the lastUsed timestamp
      getDekFromSession(token);
      
      // Advance time by another hour (almost at expiration)
      const almostExpired = oneHourLater + 59 * 60 * 1000;
      (Date.now as jest.Mock).mockReturnValue(almostExpired);
      
      // Should still be valid because we updated lastUsed
      const retrievedDek = getDekFromSession(token);
      expect(retrievedDek).toBe(dek);
    });
  });
  
  describe('invalidateSession', () => {
    test('should invalidate an existing session', () => {
      const dek = 'test-dek-value';
      const token = createSession(dek);
      
      // Verify session exists
      expect(getDekFromSession(token)).toBe(dek);
      
      // Invalidate the session
      invalidateSession(token);
      
      // Verify session no longer exists
      expect(getDekFromSession(token)).toBeNull();
    });
    
    test('should not throw an error for non-existent sessions', () => {
      // Should not throw an error
      expect(() => {
        invalidateSession('non-existent-token');
      }).not.toThrow();
    });
  });
  
  // Test cleanup function indirectly
  describe('session cleanup', () => {
    test('should automatically remove expired sessions', () => {
      // Create sessions
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        // Create sessions at the same time
        (Date.now as jest.Mock).mockReturnValue(mockNow);
        const session = {
          dek: `dek-${i}`,
          token: createSession(`dek-${i}`)
        };
        sessions.push(session);
      }
      
      // Verify all sessions exist
      (Date.now as jest.Mock).mockReturnValue(mockNow);
      sessions.forEach(session => {
        expect(getDekFromSession(session.token)).toBe(session.dek);
      });
      
      // Expire all sessions
      const expirationTime = 2 * 60 * 60 * 1000 + 1;
      (Date.now as jest.Mock).mockReturnValue(mockNow + expirationTime);
      
      // Check first session - this should trigger cleanup
      expect(getDekFromSession(sessions[0].token)).toBeNull();
      
      // Verify all sessions are now invalid
      sessions.forEach(session => {
        expect(getDekFromSession(session.token)).toBeNull();
      });
    });
  });
}); 